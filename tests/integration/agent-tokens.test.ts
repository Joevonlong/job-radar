import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { createAuditRecorder, type AuditRecorder } from "@/lib/agent-access/audit";
import type { Grant } from "@/lib/agent-access/authorize";
import type { Permission } from "@/lib/agent-access/permissions";
import { EXIT_FAILED, EXIT_OK, runAgentToken } from "@/lib/agent-access/token-cli";
import { agentTokenGrantReader, generateAgentToken, hashAgentToken, verifyAgentToken } from "@/lib/agent-access/tokens";
import { mcpSchema, type McpConfig } from "@/lib/config/schemas/mcp";
import { closeDb, getDb, schema } from "@/lib/db";
import { createReadOnlyDb, type ReadOnlyDb } from "@/lib/db/read-only-client";
import { openAgentCallsConnection } from "@/lib/db/repos/agent-calls";
import { insertAgentToken, markAgentTokenUsed, revokeAgentToken } from "@/lib/db/repos/agent-tokens";
import { seedDatabase } from "@/lib/db/seed";
import { translatorFor } from "@/lib/i18n/node";
import { buildServer, defaultContext } from "@/lib/mcp/server";
import { mcpTranslator } from "@/lib/mcp/text";

const url = inject("testDatabaseUrl");
const NOW = new Date("2026-11-11T12:00:00Z");
const text = mcpTranslator("en");
const t = translatorFor("en", "cli.agentToken");

let readOnly: ReadOnlyDb;
let jobId: number;
let closeClient: (() => Promise<void>) | undefined;
let recorder: AuditRecorder | undefined;

async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAgentToken({ db: getDb(), argv, now: () => NOW, timezone: () => "Europe/Berlin", t, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err };
}

async function created(name: string, permissions: string): Promise<string> {
  const result = await cli("create", "--name", name, "--permissions", permissions);
  expect(result.code).toBe(EXIT_OK);
  const [secret] = result.out;
  if (!secret) throw new Error("no token printed");
  return secret;
}

async function tokenGrant(secret: string): Promise<Extract<Grant, { kind: "token" }>> {
  const verified = await verifyAgentToken(readOnly.db, secret, NOW);
  if (!verified.ok) throw new Error(`token refused: ${verified.reason}`);
  return verified.grant;
}

const tokenRows = () => getDb().execute<{ row: string }>(sql`select row_to_json(t)::text as row from agent_tokens t order by id`);

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  readOnly = createReadOnlyDb({ url, connectTimeoutSeconds: 30 });
});

beforeEach(async () => {
  await seedDatabase(getDb(), { now: NOW, timezone: "Europe/Berlin" });
  const [job] = await getDb().select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.status, "active")).orderBy(schema.jobs.id).limit(1);
  if (!job) throw new Error("no active seed job");
  jobId = job.id;
});

afterEach(async () => {
  await closeClient?.();
  closeClient = undefined;
  await recorder?.close();
  recorder = undefined;
});

afterAll(async () => {
  await readOnly.close();
  await closeDb();
});

describe("the agent_tokens table", () => {
  it("is what agent_calls.token_id refers to, and a referenced token cannot be deleted", async () => {
    const token = await insertAgentToken(getDb(), { name: "fk", tokenHash: hashAgentToken("x"), tokenPrefix: "jrat_fkfkfkfk", permissions: ["jobs:read"], expiresAt: null });
    if (!token) throw new Error("not inserted");
    const call = { capability: "get_job", outcome: "ok" as const, returnedCount: 1, durationMs: 1 };
    await expect(getDb().insert(schema.agentCalls).values({ ...call, tokenId: token.id + 1000 })).rejects.toMatchObject({ cause: { code: "23503" } });
    await getDb().insert(schema.agentCalls).values({ ...call, caller: "token", tokenId: token.id });
    await getDb().insert(schema.agentCalls).values(call);
    await expect(getDb().delete(schema.agentTokens).where(eq(schema.agentTokens.id, token.id))).rejects.toMatchObject({ cause: { code: "23503" } });
    expect(await revokeAgentToken(getDb(), token.id, NOW)).toBe(true);
    expect(await revokeAgentToken(getDb(), token.id, NOW)).toBe(false);
    expect(await getDb().select({ id: schema.agentCalls.id }).from(schema.agentCalls)).toHaveLength(2);
  });

  it("holds one name once among tokens not revoked", async () => {
    const row = { tokenHash: hashAgentToken("a"), tokenPrefix: "jrat_aaaaaaaa", permissions: ["jobs:read"], expiresAt: null };
    const first = await insertAgentToken(getDb(), { name: "laptop", ...row });
    expect(await insertAgentToken(getDb(), { name: "laptop", ...row, tokenHash: hashAgentToken("b") })).toBeNull();
    await revokeAgentToken(getDb(), first!.id, NOW);
    expect(await insertAgentToken(getDb(), { name: "laptop", ...row, tokenHash: hashAgentToken("b") })).toMatchObject({ name: "laptop" });
  });
});

describe("pnpm agent:token against the database", () => {
  it("creates a token that verifies, keeping only its hash; list and revoke never show it", async () => {
    const result = await cli("create", "--name", "laptop", "--permissions", "jobs:read,tracking:read", "--expires", "2026-12-31");
    expect(result.code).toBe(EXIT_OK);
    const [secret] = result.out;
    if (!secret) throw new Error("no token printed");
    const hash = hashAgentToken(secret);
    expect(result.err.join("\n")).not.toContain(secret);

    const stored = await tokenRows();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.row).not.toContain(secret);
    expect(stored[0]!.row).not.toContain(secret.slice(13));
    const [row] = await getDb().select().from(schema.agentTokens);
    expect(row).toMatchObject({ name: "laptop", tokenHash: hash, tokenPrefix: secret.slice(0, 13), permissions: ["jobs:read", "tracking:read"], autoApprove: false, expiresAt: new Date("2026-12-31T23:00:00Z"), lastUsedAt: null, revokedAt: null });

    expect(await tokenGrant(secret)).toEqual({ kind: "token", tokenId: row!.id, permissions: ["jobs:read", "tracking:read"] });
    await expect(verifyAgentToken(readOnly.db, secret, new Date("2026-12-31T23:00:00Z"))).resolves.toEqual({ ok: false, reason: "expired" });

    const listed = await cli("list");
    const shown = [...listed.out, ...listed.err].join("\n");
    expect(shown).toContain(row!.tokenPrefix);
    expect(shown).not.toContain(secret);
    expect(shown).not.toContain(hash);

    const revoked = await cli("revoke", row!.tokenPrefix);
    expect(revoked.code).toBe(EXIT_OK);
    expect([...revoked.out, ...revoked.err].join("\n")).not.toContain(secret);
    await expect(verifyAgentToken(readOnly.db, secret, NOW)).resolves.toEqual({ ok: false, reason: "revoked" });
    expect((await cli("revoke", "laptop")).code).toBe(EXIT_FAILED);
  });

  it("refuses an unknown token and one that differs from a stored token only after its prefix", async () => {
    const secret = await created("phone", "read_only");
    const twin = `${secret.slice(0, -2)}${secret.endsWith("AA") ? "BB" : "AA"}`;
    await expect(verifyAgentToken(readOnly.db, twin, NOW)).resolves.toEqual({ ok: false, reason: "unknown" });
    await expect(verifyAgentToken(readOnly.db, generateAgentToken().secret, NOW)).resolves.toEqual({ ok: false, reason: "unknown" });
  });

  it("refuses a revoke that matches a name and another token's prefix", async () => {
    const secret = await created("laptop", "jobs:read");
    await created(secret.slice(0, 13), "jobs:read");
    const result = await cli("revoke", secret.slice(0, 13));
    expect(result.code).toBe(EXIT_FAILED);
    expect(result.err[0]).toContain(secret.slice(0, 13));
    expect(await getDb().select({ id: schema.agentTokens.id }).from(schema.agentTokens).where(sql`${schema.agentTokens.revokedAt} is not null`)).toEqual([]);
  });
});

describe("an MCP connection made with a token", () => {
  let current: McpConfig;
  let lines: string[];

  async function connect(grant: Extract<Grant, { kind: "token" }>): Promise<Client> {
    const connection = openAgentCallsConnection(url, { connectTimeoutSeconds: 2, statementTimeoutMs: 1500, lockTimeoutMs: 200 });
    recorder = createAuditRecorder(() => ({ db: connection.db, end: (options) => connection.sql.end(options) }), { text, log: (line) => lines.push(line), writeTimeoutMs: 2000 });
    const ctx = defaultContext(readOnly.db, current, {
      text,
      log: (line) => lines.push(line),
      readSettings: () => current,
      audit: recorder,
      caller: { caller: "token", tokenId: grant.tokenId, transport: "http" },
      grant,
      readGrant: agentTokenGrantReader(readOnly.db, () => NOW),
    });
    ctx.now = () => NOW;
    ctx.timezone = () => "Europe/Berlin";
    const server = buildServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "token-integration", version: "1" });
    await client.connect(clientTransport);
    closeClient = async () => {
      await client.close();
      await server.close();
    };
    return client;
  }

  const matrix = (permissions: Permission[]) => mcpSchema.parse({ enabled: true, permissions, stdio: { permissions: [] } });
  const textOf = (result: { content?: unknown }): string => ((result.content as Array<{ text?: string }> | undefined) ?? []).map((c) => c.text ?? "").join("\n");

  beforeEach(() => {
    lines = [];
    current = matrix(["jobs:read", "tracking:read"]);
  });

  it("offers the token's permissions within the matrix, audits calls with its id, and is refused from the call after a revoke", async () => {
    const secret = await created("agent", "jobs:read,notes:read");
    const grant = await tokenGrant(secret);
    const client = await connect(grant);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["search_jobs", "get_job"]);

    const ok = await client.callTool({ name: "get_job", arguments: { job_id: jobId } });
    expect(ok.isError).not.toBe(true);
    const denied = await client.callTool({ name: "list_applications", arguments: {} });
    expect(textOf(denied)).toBe(text("errors.notPermitted", { permission: "tracking:read" }));

    current = matrix(["tracking:read"]);
    const narrowed = await client.callTool({ name: "get_job", arguments: { job_id: jobId } });
    expect(textOf(narrowed)).toBe(text("errors.notPermitted", { permission: "jobs:read" }));
    current = matrix(["jobs:read", "tracking:read"]);

    expect((await cli("revoke", "agent")).code).toBe(EXIT_OK);
    const revoked = await client.callTool({ name: "get_job", arguments: { job_id: jobId } });
    expect(textOf(revoked)).toBe(text("errors.tokenInactive"));

    await recorder!.close();
    const calls = await getDb().select().from(schema.agentCalls).orderBy(schema.agentCalls.id);
    expect(calls.map((call) => [call.capability, call.outcome, call.tokenId, call.caller, call.transport])).toEqual([
      ["get_job", "ok", grant.tokenId, "token", "http"],
      ["list_applications", "not_permitted", grant.tokenId, "token", "http"],
      ["get_job", "not_permitted", grant.tokenId, "token", "http"],
      ["get_job", "not_permitted", grant.tokenId, "token", "http"],
    ]);
    const audit = await getDb().execute<{ row: string }>(sql`select row_to_json(t)::text as row from agent_calls t`);
    for (const row of audit) {
      expect(row.row).not.toContain(secret);
      expect(row.row).not.toContain(hashAgentToken(secret));
    }
    expect(lines.join("\n")).not.toContain(secret);
  });

  it("is refused once the token's expiry passes, without a restart", async () => {
    const generated = generateAgentToken();
    const row = await insertAgentToken(getDb(), { name: "short", tokenHash: generated.hash, tokenPrefix: generated.prefix, permissions: ["jobs:read"], expiresAt: new Date(NOW.getTime() + 60_000) });
    const grant = await tokenGrant(generated.secret);
    expect(grant.tokenId).toBe(row!.id);
    const client = await connect(grant);
    expect((await client.callTool({ name: "get_job", arguments: { job_id: jobId } })).isError).not.toBe(true);
    await getDb().update(schema.agentTokens).set({ expiresAt: new Date(NOW.getTime() - 1) }).where(eq(schema.agentTokens.id, row!.id));
    expect(textOf(await client.callTool({ name: "get_job", arguments: { job_id: jobId } }))).toBe(text("errors.tokenInactive"));
  });
});

describe("last use", () => {
  it("is written over a writable connection; the read-only pool refuses the write", async () => {
    const generated = generateAgentToken();
    const row = await insertAgentToken(getDb(), { name: "use", tokenHash: generated.hash, tokenPrefix: generated.prefix, permissions: ["jobs:read"], expiresAt: null });
    await expect(markAgentTokenUsed(readOnly.db, row!.id, NOW)).rejects.toMatchObject({ cause: { code: "25006" } });
    await markAgentTokenUsed(getDb(), row!.id, NOW);
    const [stored] = await getDb().select({ lastUsedAt: schema.agentTokens.lastUsedAt }).from(schema.agentTokens).where(eq(schema.agentTokens.id, row!.id));
    expect(stored?.lastUsedAt).toEqual(NOW);
  });
});

import fs from "node:fs";
import path from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { stringify } from "yaml";

import { liveMcpSettings } from "@/lib/agent-access/authorize";
import { createAgentTokenFromWeb, revokeAgentTokenFromWeb } from "@/lib/agent-access/token-service";
import { generateAgentToken, type TokenGrant } from "@/lib/agent-access/tokens";
import { mcpSchema, type McpConfig } from "@/lib/config/schemas/mcp";
import { closeDb, getDb, schema } from "@/lib/db";
import * as dbClient from "@/lib/db/client";
import { closeMcpPools, getMcpReadDb, getMcpWriteDb } from "@/lib/db/mcp-pools";
import { activeAgentTokenStats, insertAgentToken, revokeAgentToken } from "@/lib/db/repos/agent-tokens";
import { seedDatabase } from "@/lib/db/seed";
import { handleMcpHttpRequest, mcpMethodNotAllowed, realDeps, resetMcpThrottle, type McpHttpDependencies } from "@/lib/mcp/http";
import { createRealProbes } from "@/lib/ops/doctor/probes";

import { makeTempConfig, type TempConfig } from "../config/helpers";
import { NOW, rpcRequest, snapshot } from "../mcp/http-helpers";

const url = inject("testDatabaseUrl");
let temp: TempConfig;
let settings: McpConfig;
let deps: McpHttpDependencies;
let secret: string;
let tokenId: number;
let jobId: number;
const clients: Client[] = [];
const observed: { status: number; headers: Record<string, string>; body: string }[] = [];
let lines: string[];

function saveSettings(next: McpConfig) {
  settings = next;
  fs.writeFileSync(path.join(temp.configDir, "mcp.yaml"), stringify({ config_version: 3, ...settings }));
}

async function token(name: string, permissions: string[], expiresAt: Date | null = null) {
  const generated = generateAgentToken();
  const row = await insertAgentToken(getDb(), { name, tokenHash: generated.hash, tokenPrefix: generated.prefix, permissions, expiresAt });
  if (!row) throw new Error("token not created");
  return { secret: generated.secret, id: row.id };
}

async function connect() {
  const transport = new StreamableHTTPClientTransport(new URL("http://mcp.example.test/api/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${secret}` } },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const response = request.method === "POST" ? await handleMcpHttpRequest(request, deps) : mcpMethodNotAllowed();
      const result = await snapshot(response);
      observed.push(result);
      return new Response(result.body, { status: result.status, headers: result.headers });
    },
  });
  const client = new Client({ name: "http-integration", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  clients.push(client);
  await client.connect(transport);
  return { client, transport };
}

beforeAll(() => { process.env.DATABASE_URL = url; });
beforeEach(async () => {
  temp = makeTempConfig();
  resetMcpThrottle();
  lines = [];
  observed.length = 0;
  saveSettings(mcpSchema.parse({ enabled: true, permissions: ["jobs:read"], http: { enabled: true }, audit: { write_timeout_ms: 10000 } }));
  deps = { ...realDeps(), password: () => ({ kind: "plain", plain: "test-password" }), now: () => NOW, log: (line) => lines.push(line) };
  await seedDatabase(getDb(), { now: NOW, timezone: "Europe/Berlin" });
  const [job] = await getDb().select({ id: schema.jobs.id }).from(schema.jobs).limit(1);
  jobId = job!.id;
  const created = await token(`client-${crypto.randomUUID()}`, ["jobs:read", "tracking:read"]);
  secret = created.secret;
  tokenId = created.id;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await closeMcpPools();
  temp.cleanup();
  vi.restoreAllMocks();
});
afterAll(async () => { await closeDb(); });

describe("HTTP MCP against PostgreSQL", () => {
  it("negotiates modern MCP, honors live permission changes, reads tools and records token metadata without using the web pool", async () => {
    const shared = getDb();
    const sharedSpy = vi.spyOn(dbClient, "getDb");
    const { client, transport } = await connect();
    expect(transport.protocolVersion).toBe("2026-07-28");
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("get_job");
    expect(names).toContain("search_jobs");
    expect(names).not.toContain("list_applications");
    const job = await client.callTool({ name: "get_job", arguments: { job_id: jobId } });
    expect(job.isError).not.toBe(true);
    const jobs = await client.callTool({ name: "search_jobs", arguments: {} });
    expect(jobs.isError).not.toBe(true);
    saveSettings({ ...settings, permissions: ["tracking:read"] });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("list_applications");
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("get_job");
    expect((await client.callTool({ name: "get_job", arguments: { job_id: jobId } })).isError).toBe(true);
    expect(sharedSpy).not.toHaveBeenCalled();
    expect(getMcpReadDb(settings)).not.toBe(shared);
    expect(getMcpWriteDb(settings)).not.toBe(shared);
    expect(getMcpReadDb(settings)).not.toBe(getMcpWriteDb(settings));
    sharedSpy.mockRestore();
    const rows = await shared.select().from(schema.agentCalls).where(eq(schema.agentCalls.tokenId, tokenId));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) expect(row).toMatchObject({ caller: "token", tokenId, transport: "http" });
    const [used] = await shared.select({ lastUsedAt: schema.agentTokens.lastUsedAt }).from(schema.agentTokens).where(eq(schema.agentTokens.id, tokenId));
    expect(used?.lastUsedAt).toEqual(NOW);
    const probes = createRealProbes({ commandTimeoutMs: 1, probeTimeoutMs: 1, now: () => NOW, migrationsDir: import.meta.dirname });
    expect(JSON.stringify([observed, rows, lines, await probes.mcp()])).not.toContain(secret);
  });

  it("keeps tool lists, results and audit rows apart for two tokens with interleaved requests", async () => {
    saveSettings({ ...settings, permissions: ["jobs:read", "tracking:read"] });
    const jobs = await token(`jobs-${crypto.randomUUID()}`, ["jobs:read"]);
    const tracking = await token(`tracking-${crypto.randomUUID()}`, ["tracking:read"]);
    const pending = 8;
    let arrived = 0;
    const allBuilt = Promise.withResolvers<void>();
    const createHandler: McpHttpDependencies["createHandler"] = (factory, options) => realDeps().createHandler(async (context) => {
      if (++arrived === pending) allBuilt.resolve();
      await allBuilt.promise;
      return factory(context);
    }, options);
    const interleaved = { ...deps, createHandler };
    const call = async (secret: string, id: number, method: string, params: Record<string, unknown> = {}) => {
      const response = await handleMcpHttpRequest(rpcRequest({ token: secret, headers: { "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }), interleaved);
      const body = await response.text();
      expect(response.status).toBe(200);
      const data = body.split("\n").find((line) => line.startsWith("data: "));
      return JSON.parse(data!.slice(6)).result as { tools?: { name: string }[]; isError?: boolean; structuredContent?: unknown };
    };
    const getJob = { name: "get_job", arguments: { job_id: jobId } };
    const listApplications = { name: "list_applications", arguments: {} };
    const [jobsList, trackingList, jobsGet, trackingGet, jobsApps, trackingApps, jobsList2, trackingList2] = await Promise.all([
      call(jobs.secret, 1, "tools/list"), call(tracking.secret, 2, "tools/list"),
      call(jobs.secret, 3, "tools/call", getJob), call(tracking.secret, 4, "tools/call", getJob),
      call(jobs.secret, 5, "tools/call", listApplications), call(tracking.secret, 6, "tools/call", listApplications),
      call(jobs.secret, 7, "tools/list"), call(tracking.secret, 8, "tools/list"),
    ]);
    expect(arrived).toBe(pending);
    for (const list of [jobsList, jobsList2]) {
      expect(list.tools!.map((tool) => tool.name)).toContain("get_job");
      expect(list.tools!.map((tool) => tool.name)).not.toContain("list_applications");
    }
    for (const list of [trackingList, trackingList2]) {
      expect(list.tools!.map((tool) => tool.name)).toContain("list_applications");
      expect(list.tools!.map((tool) => tool.name)).not.toContain("get_job");
    }
    expect(jobsGet.isError).not.toBe(true);
    expect(JSON.stringify(jobsGet)).toContain(String(jobId));
    expect(trackingGet.isError).toBe(true);
    expect(jobsApps.isError).toBe(true);
    expect(trackingApps.isError).not.toBe(true);
    const rows = await getDb().select().from(schema.agentCalls).where(inArray(schema.agentCalls.tokenId, [jobs.id, tracking.id]));
    const audited = (id: number) => rows.filter((row) => row.tokenId === id).map((row) => `${row.capability}:${row.outcome}`).sort();
    expect(audited(jobs.id)).toEqual(["get_job:ok", "list_applications:not_permitted"]);
    expect(audited(tracking.id)).toEqual(["get_job:not_permitted", "list_applications:ok"]);
    for (const row of rows) expect(row).toMatchObject({ caller: "token", transport: "http" });
  });

  it("serves a raw legacy initialize with the requested protocol version and an SSE response", async () => {
    const response = await handleMcpHttpRequest(rpcRequest({ token: secret, headers: { "mcp-protocol-version": "2025-06-18" } }), deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    const data = body.split("\n").find((line) => line.startsWith("data: "));
    expect(JSON.parse(data!.slice(6)).result.protocolVersion).toBe("2025-06-18");
    expect(body).not.toContain(secret);
  });

  it("refuses the next request after revocation and refuses expired tokens without audit rows", async () => {
    const { client } = await connect();
    await revokeAgentToken(getDb(), tokenId, NOW);
    await expect(client.listTools()).rejects.toThrow();
    expect(observed.at(-1)).toMatchObject({ status: 401, body: '{"error":"unauthorized"}' });
    const expired = await token(`expired-${crypto.randomUUID()}`, ["jobs:read"], NOW);
    expect(await snapshot(await handleMcpHttpRequest(rpcRequest({ token: expired.secret }), deps))).toMatchObject({ status: 401, body: '{"error":"unauthorized"}' });
    expect(await getDb().select().from(schema.agentCalls).where(eq(schema.agentCalls.tokenId, expired.id))).toEqual([]);
    expect(await getDb().select().from(schema.agentCalls).where(eq(schema.agentCalls.tokenId, tokenId))).toEqual([]);
  });

  it("a token created on the settings page works over HTTP, and revoking it there refuses the very next request", async () => {
    const web = { db: getDb, now: () => NOW, timezone: () => "Europe/Berlin", matrix: () => settings.permissions, generate: generateAgentToken };
    const created = await createAgentTokenFromWeb({ name: `web-${crypto.randomUUID()}`, permissions: ["jobs:read"], expires: null }, "ok", web);
    if (created.status !== "created") throw new Error(created.status);
    const ok = await snapshot(await handleMcpHttpRequest(rpcRequest({ token: created.secret }), deps));
    expect(ok.status).toBe(200);
    expect(await revokeAgentTokenFromWeb({ id: created.token.id }, "ok", web)).toEqual({ status: "revoked" });
    expect(await snapshot(await handleMcpHttpRequest(rpcRequest({ token: created.secret }), deps))).toMatchObject({ status: 401, body: '{"error":"unauthorized"}' });
    expect(lines.join("\n")).not.toContain(created.secret);
  });

  it("re-reads the token before each tool call inside a legacy batch", async () => {
    const realReader = deps.readGrant;
    let reads = 0;
    deps.readGrant = (db, now) => async (id): Promise<TokenGrant | null> => {
      if (++reads === 2) await revokeAgentToken(getDb(), id, NOW);
      return await realReader(db, now)(id) as TokenGrant | null;
    };
    const response = await handleMcpHttpRequest(rpcRequest({ token: secret, body: JSON.stringify([1, 2].map((id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_job", arguments: { job_id: jobId } } }))) }), deps);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(reads).toBe(2);
    expect(body).toContain('"isError":true');
  });

  it("enforces read-only SQL sessions with SQLSTATE 25006", async () => {
    await expect(getMcpReadDb(settings).execute(sql`update agent_tokens set last_used_at = now() where false`)).rejects.toMatchObject({ cause: { code: "25006" } });
  });

  it("holds a tiny concurrency slot until the real legacy response ends or is cancelled", async () => {
    saveSettings({ ...settings, http: { ...settings.http, pool: { ...settings.http.pool, max_concurrent: 1 } } });
    const held = await handleMcpHttpRequest(rpcRequest({ token: secret }), deps);
    expect(await snapshot(await handleMcpHttpRequest(rpcRequest({ token: secret }), deps))).toMatchObject({ status: 503, headers: { "retry-after": "1" }, body: '{"error":"busy"}' });
    await held.body!.cancel();
    expect((await snapshot(await handleMcpHttpRequest(rpcRequest({ token: secret }), deps))).status).toBe(200);
  });

  it("aggregates active tokens and the nearest future expiry only", async () => {
    const before = await activeAgentTokenStats(getDb(), NOW);
    const later = new Date(NOW.getTime() + 600000);
    const sooner = new Date(NOW.getTime() + 60000);
    await token(`later-${crypto.randomUUID()}`, ["jobs:read"], later);
    await token(`sooner-${crypto.randomUUID()}`, ["jobs:read"], sooner);
    await token(`expired-${crypto.randomUUID()}`, ["jobs:read"], NOW);
    const revoked = await token(`revoked-${crypto.randomUUID()}`, ["jobs:read"], new Date(NOW.getTime() + 1));
    await revokeAgentToken(getDb(), revoked.id, NOW);
    expect(await activeAgentTokenStats(getDb(), NOW)).toEqual({ activeTokens: before.activeTokens + 2, nearestExpiry: sooner });
    expect(liveMcpSettings().http.enabled).toBe(true);
  });
});

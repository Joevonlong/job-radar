import net from "node:net";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { createAuditRecorder, type AuditConnection, type AuditRecorder } from "@/lib/agent-access/audit";
import { loadConfig, meSchema, storySchema, writerSchema } from "@/lib/config";
import { mcpSchema, type McpConfig } from "@/lib/config/schemas/mcp";
import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { createReadOnlyDb, type ReadOnlyDb } from "@/lib/db/read-only-client";
import { openAgentCallsConnection, pruneAgentCalls } from "@/lib/db/repos/agent-calls";
import { createApplicationQuestion, insertAnswerVersions, listAnswerVersions } from "@/lib/db/repos/application-writer";
import { seedDatabase } from "@/lib/db/seed";
import { buildServer, defaultContext } from "@/lib/mcp/server";
import { mcpTranslator } from "@/lib/mcp/text";
import { runTrapScan } from "@/lib/traps/step";

const url = inject("testDatabaseUrl");
const NOW = new Date("2026-10-07T12:00:00Z");
const text = mcpTranslator("en");
const permissions = ["jobs:read", "tracking:read", "writer:read", "writer:write"];
const writer = writerSchema.parse({ enabled: true });
const me = meSchema.parse({ summary: "SENTINEL-OUT-profile", skills: [{ name: "SENTINEL-OUT-skill", years: 3 }], languages: [{ en: "C2" }], years_experience: 3, city: "Testville", needs_visa_sponsorship: false });
const stories = [storySchema.parse({ id: "audit-story", title: "SENTINEL-OUT-story", what: "SENTINEL-OUT-material.", skills: [] })];

let readOnly: ReadOnlyDb;
let recorder: AuditRecorder;
let connection: ReturnType<typeof openAgentCallsConnection>;
let current: McpConfig;
let auditLines: string[];
let callLines: string[];
let closeClient: (() => Promise<void>) | undefined;
let jobId: number;

function settings(): McpConfig {
  return mcpSchema.parse({ enabled: true, permissions, stdio: { permissions } });
}

const WRITE_TIMEOUT_MS = 2000;

function auditConnection(target: ReturnType<typeof openAgentCallsConnection>): AuditConnection {
  return { db: target.db, end: (options) => target.sql.end(options) };
}

async function connect(audit: AuditRecorder = recorder): Promise<Client> {
  const ctx = defaultContext(readOnly.db, current, { audit, text, log: (line) => callLines.push(line), readSettings: () => current });
  ctx.now = () => NOW;
  ctx.timezone = () => "Europe/Berlin";
  ctx.writer = { inputs: () => ({ writer, me, stories, storiesUnreadable: false, breakdownEnabled: true }), writeDb: getDb() };
  const server = buildServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "audit-integration", version: "1" });
  await client.connect(clientTransport);
  closeClient = async () => {
    await client.close();
    await server.close();
  };
  return client;
}

async function question() {
  const added = await createApplicationQuestion(getDb(), {
    maxPerJob: 12,
    fields: {
      jobId, text: "SENTINEL-OUT-question", kind: "question", lengthUnit: "words", lengthValue: 150, outputLanguage: "en", tone: "neutral",
      selectedMaterials: { jdPoints: [], useJdText: true, profile: true, storyIds: ["audit-story"], emphasis: "SENTINEL-OUT-emphasis" },
    },
  });
  if (!added) throw new Error("question was not added");
  return added;
}

const rows = () => getDb().select().from(schema.agentCalls).orderBy(schema.agentCalls.id);

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
  readOnly = createReadOnlyDb({ url, connectTimeoutSeconds: 30 });
});

beforeEach(async () => {
  auditLines = [];
  callLines = [];
  current = settings();
  await getDb().delete(schema.agentCalls);
  connection = openAgentCallsConnection(url, { connectTimeoutSeconds: 2, statementTimeoutMs: 1500, lockTimeoutMs: 200 });
  recorder = createAuditRecorder(() => auditConnection(connection), { text, log: (line) => auditLines.push(line), writeTimeoutMs: WRITE_TIMEOUT_MS });
  await seedDatabase(getDb(), { now: NOW, timezone: "Europe/Berlin" });
  const [job] = await getDb().select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.status, "active")).orderBy(schema.jobs.id).limit(1);
  if (!job) throw new Error("no active seed job");
  jobId = job.id;
});

afterEach(async () => {
  await closeClient?.();
  closeClient = undefined;
  await recorder.close();
});

afterAll(async () => {
  await readOnly.close();
  await closeDb();
});

describe("MCP audit persistence", () => {
  it.each(["ok", "not_permitted", "invalid_input", "error"] as const)("writes exactly one complete %s row", async (outcome) => {
    const client = await connect();
    await client.listTools();
    expect(await rows()).toEqual([]);
    if (outcome === "not_permitted") current = mcpSchema.parse({ enabled: true, permissions: [] });
    const id = outcome === "error" ? 999_999 : jobId;
    const before = new Date();
    const result = await client.callTool({ name: "get_job", arguments: { job_id: outcome === "invalid_input" ? "SENTINEL-ARG-invalid" : id } });
    expect(result.isError === true).toBe(outcome !== "ok");
    if (outcome === "invalid_input") await recorder.close();
    const recorded = await rows();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({
      id: expect.any(Number), calledAt: expect.any(Date), caller: "stdio", tokenId: null, transport: "stdio", capability: "get_job",
      targetType: outcome === "invalid_input" ? null : "job", targetId: outcome === "invalid_input" ? null : id,
      outcome, errorCategory: outcome === "error" ? "not_found" : null, returnedCount: outcome === "ok" ? 1 : 0, durationMs: expect.any(Number),
    });
    expect(recorded[0]!.calledAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(Number.isInteger(recorded[0]!.durationMs)).toBe(true);
    expect(recorded[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(auditLines).toEqual([]);
    expect(callLines).toHaveLength(1);
  });

  it("keeps sentinels in all five tools' arguments and returned business data out of every audit column", async () => {
    const title = "SENTINEL-OUT-title SENTINEL-ARG-search";
    const [job] = await getDb().select({ companyId: schema.jobs.companyId }).from(schema.jobs).where(eq(schema.jobs.id, jobId));
    await getDb().update(schema.jobs).set({ title, description: "SENTINEL-OUT-description: build reliable software." }).where(eq(schema.jobs.id, jobId));
    await getDb().update(schema.companies).set({ name: "SENTINEL-OUT-company" }).where(eq(schema.companies.id, job!.companyId));
    await getDb().insert(schema.applications).values({ jobId, status: "interested", nextAction: "SENTINEL-OUT-application", notesMd: "SENTINEL-OUT-notes" })
      .onConflictDoUpdate({ target: schema.applications.jobId, set: { status: "interested", nextAction: "SENTINEL-OUT-application", notesMd: "SENTINEL-OUT-notes" } });
    const q = await question();
    await insertAnswerVersions(getDb(), { questionId: q.id, maxVersions: 10, versions: [{ mode: "manual", text: "SENTINEL-OUT-answer.", sentences: [] }] });
    const scan = await runTrapScan(getDb(), { settings: loadConfig("traps"), channels: { get: () => undefined }, logger: { info: () => {}, warn: () => {}, error: () => {} }, limit: 1, jobIds: [jobId], force: true });
    expect(scan.failed).toBe(0);
    const client = await connect();
    const calls = [
      { name: "search_jobs", args: { query: "SENTINEL-ARG-search" }, expected: ["SENTINEL-OUT-title", "SENTINEL-OUT-company"] },
      { name: "get_job", args: { job_id: jobId }, expected: ["SENTINEL-OUT-description", "SENTINEL-OUT-application"] },
      { name: "list_applications", args: {}, expected: ["SENTINEL-OUT-application", "SENTINEL-OUT-title"] },
      { name: "get_application_context", args: { job_id: jobId }, expected: ["SENTINEL-OUT-question", "SENTINEL-OUT-profile", "SENTINEL-OUT-material", "SENTINEL-OUT-emphasis", "SENTINEL-OUT-answer"] },
      { name: "save_application_answer", args: { job_id: jobId, question_id: q.id, text: "SENTINEL-ARG-answer." }, expected: [] },
    ];
    for (const call of calls) {
      const invalid = await client.callTool({ name: call.name, arguments: { ...call.args, unexpected: `SENTINEL-ARG-${call.name}` } });
      expect(invalid.isError).toBe(true);
      const result = await client.callTool({ name: call.name, arguments: call.args });
      expect(result.isError).not.toBe(true);
      for (const sentinel of call.expected) expect(JSON.stringify(result.structuredContent)).toContain(sentinel);
    }
    const context = await client.callTool({ name: "get_application_context", arguments: { job_id: jobId } });
    expect(JSON.stringify(context.structuredContent)).toContain("SENTINEL-ARG-answer");
    await recorder.close();
    const metadata = await getDb().execute<{ row: string }>(sql`select row_to_json(t)::text as row from agent_calls t order by id`);
    expect(metadata).toHaveLength(11);
    for (const row of metadata) expect(row.row).not.toContain("SENTINEL");
    const recorded = await rows();
    for (const call of calls) {
      expect(recorded.filter((row) => row.capability === call.name && row.outcome === "invalid_input")).toHaveLength(1);
      expect(recorded.filter((row) => row.capability === call.name && row.outcome === "ok")).toHaveLength(call.name === "get_application_context" ? 2 : 1);
    }
    expect(recorded.find((row) => row.capability === "get_application_context" && row.outcome === "ok")).toMatchObject({ targetType: "job", targetId: jobId, returnedCount: 1 });
    expect(recorded.find((row) => row.capability === "save_application_answer" && row.outcome === "ok")).toMatchObject({ targetType: "question", targetId: q.id, returnedCount: 1 });
    expect(recorded.filter((row) => ["search_jobs", "list_applications"].includes(row.capability)).every((row) => row.targetId === null && row.targetType === null)).toBe(true);
  });

  it("still returns the normal read result and one safe stderr line when the audit connection is unavailable", async () => {
    await connection.sql.end();
    const client = await connect();
    const result = await client.callTool({ name: "get_job", arguments: { job_id: jobId } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ job: { id: jobId } });
    expect(auditLines).toEqual([text("serve.auditFailed", { category: "database" })]);
    expect(callLines).toEqual([expect.stringMatching(/^\[mcp\] get_job ok items=1 ms=\d+$/)]);
    expect(await rows()).toEqual([]);
  });

  it("saves one answer and one audit row on the write transaction even when the dedicated audit connection is unavailable", async () => {
    const q = await question();
    await connection.sql.end();
    const client = await connect();
    const result = await client.callTool({ name: "save_application_answer", arguments: { job_id: jobId, question_id: q.id, text: "An answer from the client." } });
    expect(result.isError).not.toBe(true);
    expect(await listAnswerVersions(getDb(), [q.id])).toHaveLength(1);
    const recorded = await rows();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ capability: "save_application_answer", targetType: "question", targetId: q.id, outcome: "ok", errorCategory: null, returnedCount: 1 });
    expect(auditLines).toEqual([]);
  });

  it("rolls back the answer when its in-transaction audit insert fails, then records one error row", async () => {
    const q = await question();
    await getDb().execute(sql`alter table agent_calls add constraint audit_reject_answer_success check (capability <> 'save_application_answer' or outcome <> 'ok')`);
    try {
      const client = await connect();
      const result = await client.callTool({ name: "save_application_answer", arguments: { job_id: jobId, question_id: q.id, text: "SENTINEL-ARG-rollback." } });
      expect(result.isError).toBe(true);
      expect(await listAnswerVersions(getDb(), [q.id])).toEqual([]);
      const recorded = await rows();
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ capability: "save_application_answer", targetType: "question", targetId: q.id, outcome: "error", errorCategory: "database", returnedCount: 0 });
      expect(auditLines).toEqual([]);
    } finally {
      await getDb().execute(sql`alter table agent_calls drop constraint audit_reject_answer_success`);
    }
  });

  it("prunes only calls strictly older than retention, keeping the cutoff and newer rows", async () => {
    const retention = mcpSchema.parse({ audit: { retention_days: 2 } }).audit.retention_days;
    const cutoff = new Date(NOW.getTime() - retention * 86_400_000);
    const base = { capability: "get_job", outcome: "ok" as const, returnedCount: 1, durationMs: 1 };
    await getDb().insert(schema.agentCalls).values([
      { ...base, calledAt: new Date(cutoff.getTime() - 1) }, { ...base, calledAt: cutoff }, { ...base, calledAt: NOW },
    ]);
    expect(await pruneAgentCalls(getDb(), cutoff)).toBe(1);
    expect((await rows()).map((row) => row.calledAt)).toEqual([cutoff, NOW]);
    expect(await pruneAgentCalls(getDb(), cutoff)).toBe(0);
  });

  it("starts the dedicated audit session with all configured timeouts", async () => {
    const [session] = await connection.db.execute<{ statement: string; lock: string; idle: string }>(sql`select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock, current_setting('idle_in_transaction_session_timeout') as idle`);
    expect(session).toEqual({ statement: "1500ms", lock: "200ms", idle: "1500ms" });
  });

  it("keeps the read-only guard for both business data and the audit table", async () => {
    await expect(readOnly.db.insert(schema.companies).values({ name: "test", nameNorm: "test" })).rejects.toMatchObject({ cause: { code: "25006" } });
    await expect(readOnly.db.insert(schema.agentCalls).values({ capability: "get_job", outcome: "ok", returnedCount: 1, durationMs: 0 })).rejects.toMatchObject({ cause: { code: "25006" } });
  });
});

/** A TCP proxy in front of the test database that can hold back the server's replies while still forwarding queries. */
async function pausingProxy() {
  const target = new URL(url);
  const sockets = new Set<net.Socket>();
  const held: Array<() => void> = [];
  let paused = false;
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port || 5432), target.hostname);
    sockets.add(client).add(upstream);
    client.on("data", (chunk) => upstream.write(chunk));
    upstream.on("data", (chunk) => {
      if (paused) held.push(() => { if (!client.destroyed) client.write(chunk); });
      else client.write(chunk);
    });
    const end = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on("close", end).on("error", end);
    upstream.on("close", end).on("error", end);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("proxy has no TCP address");
  const proxied = new URL(url);
  proxied.hostname = "127.0.0.1";
  proxied.port = String(address.port);
  return {
    url: proxied.toString(),
    connections: () => sockets.size / 2,
    pause: () => { paused = true; },
    resume: () => {
      paused = false;
      for (const flush of held.splice(0)) flush();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("MCP audit waits are bounded", () => {
  const FAST_TIMEOUT_MS = 400;
  let proxy: Awaited<ReturnType<typeof pausingProxy>>;
  let opened: Array<ReturnType<typeof openAgentCallsConnection>>;
  let bounded: AuditRecorder;

  beforeEach(async () => {
    proxy = await pausingProxy();
    opened = [];
    bounded = createAuditRecorder(() => {
      const next = openAgentCallsConnection(proxy.url, { connectTimeoutSeconds: 2, statementTimeoutMs: 1500, lockTimeoutMs: 200 });
      opened.push(next);
      return auditConnection(next);
    }, { text, log: (line) => auditLines.push(line), writeTimeoutMs: FAST_TIMEOUT_MS });
  });

  afterEach(async () => {
    proxy.resume();
    await bounded.close();
    await Promise.all(opened.map((next) => next.sql.end({ timeout: 0 })));
    await proxy.close();
  });

  it("answers a read within the deadline when the audit reply stalls, then writes the next row on a new session without repeating the stalled one", async () => {
    const client = await connect(bounded);
    expect((await client.callTool({ name: "get_job", arguments: { job_id: jobId } })).isError).not.toBe(true);
    expect(await rows()).toHaveLength(1);

    proxy.pause();
    const started = performance.now();
    const stalled = await client.callTool({ name: "get_job", arguments: { job_id: jobId } });
    const elapsed = performance.now() - started;
    expect(stalled.isError).not.toBe(true);
    expect(stalled.structuredContent).toMatchObject({ job: { id: jobId } });
    expect(elapsed).toBeGreaterThanOrEqual(FAST_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(FAST_TIMEOUT_MS + 1000);
    expect(auditLines).toEqual([text("serve.auditFailed", { category: "timeout" })]);

    proxy.resume();
    expect((await client.callTool({ name: "get_job", arguments: { job_id: jobId } })).isError).not.toBe(true);
    expect(opened).toHaveLength(2);
    await bounded.close();
    const recorded = await rows();
    expect(recorded).toHaveLength(3);
    expect(recorded.every((row) => row.capability === "get_job" && row.outcome === "ok")).toBe(true);
    expect(auditLines).toHaveLength(1);
  });

  it("closes within the deadline while a row is stalled and leaves no proxied session open", async () => {
    const client = await connect(bounded);
    expect((await client.callTool({ name: "get_job", arguments: { job_id: jobId } })).isError).not.toBe(true);
    proxy.pause();
    const call = client.callTool({ name: "get_job", arguments: { job_id: jobId } });
    await new Promise((resolve) => setTimeout(resolve, FAST_TIMEOUT_MS / 4));
    const started = performance.now();
    await bounded.close();
    expect(performance.now() - started).toBeLessThan(FAST_TIMEOUT_MS + 1000);
    expect((await call).isError).not.toBe(true);
    await expect.poll(() => proxy.connections(), { timeout: 2000 }).toBe(0);
    const before = auditLines.length;
    await bounded.record({ caller: "stdio", token_id: null, transport: "stdio", capability: "get_job", target: null, outcome: "ok", error_category: null, returned_count: 1, duration_ms: 1 });
    expect(auditLines.slice(before)).toEqual([text("serve.auditFailed", { category: "closed" })]);
    expect(opened).toHaveLength(1);
  });

  it("stops waiting for a row held up by a lock on agent_calls and keeps a later row once the lock is gone", async () => {
    const holder = openAgentCallsConnection(url, { connectTimeoutSeconds: 2, statementTimeoutMs: 60_000, lockTimeoutMs: 60_000 });
    const lockedRecorder = createAuditRecorder(() => {
      const next = openAgentCallsConnection(url, { connectTimeoutSeconds: 2, statementTimeoutMs: 60_000, lockTimeoutMs: 60_000 });
      opened.push(next);
      return auditConnection(next);
    }, { text, log: (line) => auditLines.push(line), writeTimeoutMs: FAST_TIMEOUT_MS });
    const release = Promise.withResolvers<void>();
    const locked = Promise.withResolvers<void>();
    const holding = holder.sql.begin(async (tx) => {
      await tx`lock table agent_calls in access exclusive mode`;
      locked.resolve();
      await release.promise;
    });
    const client = await connect(lockedRecorder);
    try {
      await locked.promise;
      const started = performance.now();
      const result = await client.callTool({ name: "get_job", arguments: { job_id: jobId } });
      expect(result.isError).not.toBe(true);
      expect(performance.now() - started).toBeLessThan(FAST_TIMEOUT_MS + 1000);
      expect(auditLines).toEqual([text("serve.auditFailed", { category: "timeout" })]);
    } finally {
      release.resolve();
      await holding;
      await holder.sql.end({ timeout: 1 });
    }
    expect((await client.callTool({ name: "get_job", arguments: { job_id: jobId } })).isError).not.toBe(true);
    await lockedRecorder.close();
    expect(auditLines).toHaveLength(1);
    expect(opened).toHaveLength(2);
    expect((await rows()).length).toBeLessThanOrEqual(2);
    expect(await rows()).toContainEqual(expect.objectContaining({ capability: "get_job", outcome: "ok" }));
  });
});


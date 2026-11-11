import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, inject, it } from "vitest";
import { z } from "zod";

import { loadConfig, resetConfigCache } from "@/lib/config";
import { mcpSchema, type McpConfig } from "@/lib/config/schemas/mcp";
import { closeDb, getDb, getDbNow, schema } from "@/lib/db";
import { createReadOnlyDb, type ReadOnlyDb } from "@/lib/db/read-only-client";
import { dayInZone } from "@/lib/insights/range";
import { activityLogOutput, aiUsageOutput, listChannelsOutput, listCyclesOutput, systemStatusOutput } from "@/lib/mcp/dto/ops";
import { buildServer, defaultContext } from "@/lib/mcp/server";
import { mcpTranslator } from "@/lib/mcp/text";
import type { DoctorReport } from "@/lib/ops/doctor/types";
import { makeTempConfig, type TempConfig } from "../config/helpers";
import { activityEvent, activityRow } from "./activity-helpers";

const sentinels = ["/tmp/ops-private-sentinel/key", "https://ops-private.invalid/token", "postgres://ops-secret:password@db-private.invalid:55464/private", "com.private.worker", "C:\\ops-private\\key"];
const secret = sentinels.join(" ");
const tools = ["get_system_status", "list_cycles", "list_channels", "get_activity_log", "get_ai_usage"];
let temp: TempConfig;
let readOnly: ReadOnlyDb;
let settings: McpConfig;
let now: Date;
let day: string;
let cycleId: number;
let rootId: string;
let close: (() => Promise<void>) | undefined;
let lines: string[];
let doctor: () => Promise<DoctorReport>;

beforeAll(() => {
  process.env.DATABASE_URL = inject("testDatabaseUrl");
  readOnly = createReadOnlyDb({ url: inject("testDatabaseUrl") });
});
beforeEach(async () => {
  temp = makeTempConfig();
  const schedule = loadConfig("schedule");
  fs.writeFileSync(path.join(temp.configDir, "schedule.yaml"), stringify({ ...schedule, timezone: "UTC" }));
  const sources = structuredClone(loadConfig("channels"));
  sources.linkedin.session.site.auth_file = path.join(temp.root, "missing-auth");
  sources.sources.jsearch.enabled = true;
  sources.sources.jsearch.monthly_budget_usd = 12;
  fs.writeFileSync(path.join(temp.configDir, "sources.yaml"), stringify(sources));
  fs.writeFileSync(path.join(temp.configDir, "models.yaml"), stringify({ providers: {
    anthropic: { models: [{ id: "example-model", price: { input_per_mtok: 1, output_per_mtok: 1 } }] },
  } }));
  resetConfigCache();
  settings = mcpSchema.parse({ enabled: true, permissions: ["ops:read"], stdio: { permissions: ["ops:read"] }, limits: { max_results: 50 } });
  lines = [];
  now = await getDbNow(getDb());
  day = dayInZone(now, "UTC");
  doctor = async () => ({ generatedAt: now.toISOString(), locale: "en", worst: "fail", exitCode: 2, summary: { ok: 0, warn: 0, fail: 3 }, checks: [
    { id: "backup.recent", status: "fail", group: "data", title: secret, detail: secret, hint: secret },
    { id: "aiworker.launchd", status: "fail", group: "processes", title: secret, detail: secret, hint: secret },
    { id: secret, status: "fail", group: "data", title: secret, detail: secret },
  ] });
  const db = getDb();
  await db.insert(schema.channels).values({ id: "jsearch", family: "fixture", kind: "paid", health: "down", circuitState: "open", circuitOpenUntil: new Date(now.getTime() + 600_000), consecutiveFailures: 3, lastErrorCode: secret, monthUsage: { [day.slice(0, 7)]: { records: 7, usd: 1.5 } } });
  const [cycle] = await db.insert(schema.cycles).values({ kind: "manual", startedAt: now, finishedAt: now, status: "partial", summaryJson: { detail: secret, steps: [
    { name: "collect", status: "partial", error: secret, result: { queries: 2, channels: { jsearch: { fetched: 7, failed: 1, error: secret } }, leak: secret } },
    { name: "pipeline", status: "ok", result: { processed: 7, parsed: 5, created: 4, parseFailed: 2, failures: [secret] } },
    { name: secret, status: "failed", result: { processed: 999 } },
  ] } }).returning();
  cycleId = cycle!.id;
  await db.insert(schema.cycles).values({ kind: "catchup", startedAt: new Date(now.getTime() - 1000), status: "running" });
  await db.insert(schema.runs).values([
    { channelId: "jsearch", cycleId, startedAt: now, finishedAt: now, status: "partial", fetched: 7, newCount: 4, interrupted: true, usageUnits: 3, windowHours: 48, windowExtended: true, error: secret, errorCode: "network", queryHash: secret },
    { channelId: "jsearch", cycleId, startedAt: new Date(now.getTime() - 1000), status: "failed", error: secret, errorCode: secret },
  ]);
  const root = activityRow({ scope: "cycle", name: "cycle", cycleId, status: "failed", startedAt: now, finishedAt: now, lastActivityAt: now, progressDone: 1, progressTotal: 2 });
  rootId = root.id;
  const span = activityRow({ rootId, parentId: rootId, name: "step.collect", status: "failed", reasonCode: "network", startedAt: now, lastActivityAt: now });
  await db.insert(schema.activitySpans).values([root, span]);
  await db.insert(schema.activityEvents).values(activityEvent(span, { level: "error", code: "item.failed", params: { count: 2, error_code: secret, detail: secret } }));
  const [company] = await db.insert(schema.companies).values({ name: secret, nameNorm: "private" }).returning();
  const [job] = await db.insert(schema.jobs).values({ title: secret, titleNorm: "private", companyId: company!.id }).returning();
  await db.insert(schema.aiUsage).values([
    { provider: "anthropic", task: "score", model: "example-model", tokensIn: 100, tokensOut: 20, durationMs: 500, costEstimate: 0.2, equivalentCostUsd: 0.2, outcome: "ok", at: now, jobId: job!.id },
    { provider: "anthropic", task: "score", model: "example-model", tokensIn: 50, tokensOut: 10, durationMs: 300, costEstimate: 0.1, equivalentCostUsd: 0.1, outcome: "ok", at: now, jobId: job!.id },
    { provider: secret, task: secret, model: secret, errorKind: secret, outcome: "failed", at: now, jobId: job!.id },
  ]);
  await db.insert(schema.runnerHeartbeats).values([{ process: "runner", at: now }, { process: "ai-worker", at: now }]);
  await db.insert(schema.controlRequests).values(Array.from({ length: 31 }, () => ({ kind: "test_ai" as const, status: "pending" as const, payload: { detail: secret } })));
  await db.insert(schema.runtimeState).values({ key: "host_disk", value: { diskFreeBytes: 0, diskTotalBytes: 1000, diskPath: secret }, updatedAt: now });
});
afterEach(async () => { await close?.(); close = undefined; temp.cleanup(); });
afterAll(async () => { await readOnly.close(); await closeDb(); });

async function connect() {
  const ctx = defaultContext(readOnly.db, settings, { text: mcpTranslator("en"), readSettings: () => settings, log: (line) => lines.push(line) });
  ctx.ops = { doctor: () => doctor() };
  const server = buildServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "ops-test", version: "1" });
  await client.connect(clientTransport);
  close = async () => { await client.close(); await server.close(); };
  return client;
}

function assertPrivate(value: unknown) {
  const output = JSON.stringify(value);
  for (const sentinel of sentinels) expect(output).not.toContain(sentinel);
  expect(output).not.toMatch(/postgres(?:ql)?:\/\/|https?:\/\/|\/tmp\/|\/Users\/|\/Volumes\/|[A-Z]:\\|127\.0\.0\.1|db-private|ops-private/);
  expect(output).not.toMatch(/"(?:job_id|jobId|job|job_title|company)"/);
}

function assertStrict(schema: z.ZodType, value: unknown) {
  function walk(node: unknown, keys: (string | number)[]) {
    if (Array.isArray(node)) { node.forEach((child, index) => walk(child, [...keys, index])); return; }
    if (typeof node !== "object" || node === null) return;
    const changed = structuredClone(value);
    let target = changed as Record<string | number, unknown>;
    for (const key of keys) target = target[key] as Record<string | number, unknown>;
    target.unlisted_field = secret;
    expect(schema.safeParse(changed).success, keys.join(".")).toBe(false);
    for (const [key, child] of Object.entries(node)) walk(child, [...keys, key]);
  }
  expect(schema.safeParse(value).success).toBe(true);
  walk(value, []);
}

async function call<T>(client: Client, name: string, schema: z.ZodType<T>, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  assertPrivate(result);
  assertStrict(schema, result.structuredContent);
  return schema.parse(result.structuredContent);
}

it("serves all five tools over the read-only connection with strict allow-lists and correct seeded values", async () => {
  const client = await connect();
  expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([...tools].sort());
  const status = await call(client, "get_system_status", systemStatusOutput);
  expect(status).toMatchObject({ runner_online: true, ai_worker_online: true, cycle_running: true, pending_requests: 31, disk: "fail" });
  expect(status.doctor.checks).toEqual([
    { id: "backup.recent", status: "fail", summary: "Check failed." }, { id: "aiworker.launchd", status: "fail", summary: "Check failed." }, { id: "unknown", status: "fail", summary: "Check failed." },
  ]);
  const cycles = await call(client, "list_cycles", listCyclesOutput, { cycle_id: cycleId });
  expect(cycles.returned).toBe(2);
  expect(cycles.cycles[0]?.steps).toEqual([{ name: "collect", status: "partial", counts: { queries: 2, fetched: 7, failed: 1 } }, { name: "pipeline", status: "ok", counts: { processed: 7, parsed: 5, created: 4, parseFailed: 2 } }]);
  expect(cycles.expanded?.runs[0]).toMatchObject({ channel_id: "jsearch", fetched: 7, interrupted: true, usage_units: 3, window_hours: 48, window_extended: true, error: { category: "channel", code: "network" } });
  expect(cycles.expanded?.runs[1]?.error).toEqual({ category: "channel", code: "other" });
  const channels = await call(client, "list_channels", listChannelsOutput);
  expect(channels.month).toBe(day.slice(0, 7));
  expect(channels.channels.find((row) => row.id === "jsearch")).toMatchObject({ breaker: { state: "open", consecutive_failures: 3, error: { category: "channel", code: "other" } }, usage: { records: 7, usd: 1.5, budget_usd: 12 }, latest_run: { fetched: 7, interrupted: true } });
  const activity = await call(client, "get_activity_log", activityLogOutput, { from: day, to: day });
  expect(activity).toMatchObject({ state: "ready", total: 1, roots: [{ id: rootId, status: "failed", progress_done: 1, progress_total: 2, error_events: 1 }] });
  const detail = await call(client, "get_activity_log", activityLogOutput, { root_id: rootId });
  expect(detail.detail).toMatchObject({ root: { id: rootId }, events: [{ code: "item.failed", count: 2, error: { category: "activity", code: "other" } }] });
  const usage = await call(client, "get_ai_usage", aiUsageOutput, { range: "today" });
  expect(usage.totals).toMatchObject({ calls: 3, tokens_in: 150, tokens_out: 30, duration_ms: 800, duration_unknown_calls: 1, token_unknown_calls: 1 });
  expect(usage.totals.cost_usd).toBeCloseTo(0.3);
  expect(usage.by_day).toMatchObject([{ day, calls: 3 }]);
  expect(usage.by_task).toMatchObject([{ task: "score", calls: 2 }, { task: "unknown", calls: 1 }]);
  expect(usage.by_model).toMatchObject([{ provider: "anthropic", model: "example-model", calls: 2 }, { provider: "unknown", model: null, calls: 1 }]);
  expect(lines).toHaveLength(6);
  assertPrivate(lines);
});

it("enforces both permission lists live and refuses calls after revocation", async () => {
  const client = await connect();
  for (const change of [{ permissions: [] }, { stdio: { permissions: [] } }, { enabled: false }]) {
    const allowed = settings;
    settings = mcpSchema.parse({ ...settings, ...change });
    expect((await client.listTools()).tools).toEqual([]);
    for (const name of tools) {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).toBe(true);
      assertPrivate(result);
    }
    settings = allowed;
  }
});

it.each([
  ["host", "private-db-host"], ["path", "private/resume"], ["token", "sk-ops-sentinel123"],
  ["URL", "https://private.example/x"], ["oversized name", "x".repeat(300)],
])("withholds an untrusted model containing a %s through MCP independently", async (_kind, model) => {
  await getDb().insert(schema.aiUsage).values({ provider: "anthropic", task: "probe", model, at: now });
  const client = await connect();
  const result = await client.callTool({ name: "get_ai_usage", arguments: { range: "today", task: "probe" } });
  expect(result.isError).not.toBe(true);
  expect(aiUsageOutput.parse(result.structuredContent).by_model).toMatchObject([{ provider: "anthropic", model: null, calls: 1 }]);
  expect(JSON.stringify(result)).not.toContain(model);
});

it("withholds known model ids when the catalog cannot be read", async () => {
  fs.writeFileSync(path.join(temp.configDir, "models.yaml"), "providers: [");
  const client = await connect();
  const usage = await call(client, "get_ai_usage", aiUsageOutput, { range: "today" });
  expect(usage.by_model.every((row) => row.model === null)).toBe(true);
  expect(JSON.stringify(usage)).not.toContain("example-model");
});

it("keeps newest days and largest groups when usage exceeds the configured result limit", async () => {
  settings.limits.max_results = 1;
  const oldest = new Date(`${day}T00:00:00Z`);
  oldest.setUTCDate(oldest.getUTCDate() - 2);
  const middle = new Date(oldest);
  middle.setUTCDate(middle.getUTCDate() + 1);
  await getDb().insert(schema.aiUsage).values([
    { provider: "anthropic", task: "probe", model: "example-model", at: oldest },
    { provider: "anthropic", task: "probe", model: "example-model", at: middle },
    ...Array.from({ length: 4 }, () => ({ provider: "anthropic", task: "translate", model: "example-model", at: now })),
  ]);
  const client = await connect();
  const usage = await call(client, "get_ai_usage", aiUsageOutput, { range: "7d", limit: 50 });
  expect(usage).toMatchObject({ truncated: true, by_day: [{ day, calls: 7 }], by_task: [{ task: "translate", calls: 4 }], by_model: [{ model: "example-model", calls: 8 }] });
  expect(usage.by_day).toHaveLength(1);
  expect(usage.by_day.some((row) => row.day === oldest.toISOString().slice(0, 10))).toBe(false);
  expect(usage.totals.calls).toBe(9);
});

it("keeps the latest expanded run, span and event when truncating operations history", async () => {
  settings.limits.max_results = 1;
  const later = new Date(now.getTime() + 1000);
  const [run] = await getDb().insert(schema.runs).values({ channelId: "jsearch", cycleId, startedAt: later, status: "succeeded" }).returning();
  const span = activityRow({ rootId, parentId: rootId, name: "step.collect", startedAt: later });
  await getDb().insert(schema.activitySpans).values(span);
  const event = activityEvent(span, { at: later, level: "info", code: "item.failed", params: { count: 9 } });
  await getDb().insert(schema.activityEvents).values(event);
  const client = await connect();
  const cycles = await call(client, "list_cycles", listCyclesOutput, { cycle_id: cycleId });
  expect(cycles.expanded).toMatchObject({ runs: [{ id: run!.id }], truncated: true });
  const activity = await call(client, "get_activity_log", activityLogOutput, { root_id: rootId });
  expect(activity).toMatchObject({ truncated: true, detail: { spans: [{ id: span.id }], spans_truncated: true, events: [{ id: event.id }] } });
});

it("caps lists and expansions using its own settings and rejects unrecognized or invalid input", async () => {
  settings.limits.max_results = 1;
  const client = await connect();
  const cycles = await call(client, "list_cycles", listCyclesOutput, { limit: 50, cycle_id: cycleId });
  expect(cycles).toMatchObject({ returned: 1, truncated: true, expanded: { returned: 1, truncated: true } });
  const channels = await call(client, "list_channels", listChannelsOutput, { limit: 50 });
  expect(channels).toMatchObject({ returned: 1, truncated: true });
  const usage = await call(client, "get_ai_usage", aiUsageOutput, { range: "today", limit: 50 });
  expect(usage.truncated).toBe(true);
  expect(usage.by_task).toHaveLength(1);
  expect(usage.totals.calls).toBe(3);
  for (const [name, args] of [["get_system_status", { path: secret }], ["get_activity_log", { root_id: secret }], ["get_ai_usage", { job_id: 1 }], ["get_ai_usage", { range: "custom", from: "2026-01-02", to: "2026-01-01" }]] as const) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    assertPrivate(result);
  }
});

it("contains unexpected probe errors without returning messages, causes or connection addresses", async () => {
  doctor = async () => { throw Object.assign(new Error(secret), { code: secret, cause: new Error(secret) }); };
  const client = await connect();
  const result = await client.callTool({ name: "get_system_status", arguments: {} });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain("database");
  assertPrivate(result);
  assertPrivate(lines);
});

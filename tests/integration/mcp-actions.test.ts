import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";
import { parseDocument, stringify } from "yaml";
import { afterAll, afterEach, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";

import { createAuditRecorder } from "@/lib/agent-access/audit";
import { readAgentBudget, takeIndirectBudget } from "@/lib/agent-access/budget";
import type { Permission } from "@/lib/agent-access/permissions";
import { CAPABILITIES } from "@/lib/capabilities/registry";
import { runAction } from "@/lib/capabilities/actions/run-action";
import { resetConfigCache, writerSchema } from "@/lib/config";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import { readSalaryActionSettings, readCompanyActionSettings } from "@/lib/control/action-settings";
import { requestRunCycle, requestScoreJobs, requestModelsSync } from "@/lib/control/service";
import { requestSalaryLookup } from "@/lib/control/salary-request";
import { requestCompanyResearch } from "@/lib/control/company-research-request";
import { requestTranslateJob } from "@/lib/control/translate-request";
import { runCycleHandler } from "@/lib/control/handlers";
import { closeDb, createConnection, getDb, schema, writeHeartbeat, createCycle, finishCycle } from "@/lib/db";
import { withCycleLock } from "@/lib/db/cycle-lock";
import { runMigrations } from "@/lib/db/migrate";
import { createReadOnlyDb, type ReadOnlyDb } from "@/lib/db/read-only-client";
import { createApplicationQuestion } from "@/lib/db/repos/application-writer";
import { getOrCreateCompany } from "@/lib/db/repos/companies";
import { getControlRequest, insertControlRequest, finishControlRequest, claimNextControlRequest } from "@/lib/db/repos/control-requests";
import { insertJob } from "@/lib/db/repos/jobs";
import { upsertTranslation } from "@/lib/db/repos/translations";
import type { ActionOutput, RequestStatusOutput } from "@/lib/mcp/dto/actions";
import { buildServer, defaultContext } from "@/lib/mcp/server";
import { mcpTranslator } from "@/lib/mcp/text";
import { descriptionHash } from "@/lib/translation/hash";
import { tempCareer } from "../career/fixtures";
import { quietLogger } from "../cycle/helpers";

const url = inject("testDatabaseUrl");
const NOW = new Date("2026-11-11T12:00:00Z");
const db = () => getDb();
const actions = CAPABILITIES.filter((cap) => cap.permission === "actions:run").map((cap) => cap.id);
const permissions: Permission[] = ["actions:run", "writer:write"];
let temp: ReturnType<typeof tempCareer>;
let readOnly: ReadOnlyDb;
let closes: (() => Promise<void>)[] = [];
let snapshotId: number;

function setting(file: string, keys: string[], value: unknown, reset = true) {
  const target = path.join(temp.configDir, `${file}.yaml`);
  const source = fs.existsSync(target) ? target : path.join(temp.defaultsDir, `${file}.yaml`);
  const doc = parseDocument(fs.readFileSync(source, "utf8"));
  doc.setIn(keys, value);
  fs.writeFileSync(target, doc.toString());
  if (reset) resetConfigCache();
}

async function job() {
  const company = await getOrCreateCompany(db(), { name: "Action Example", nameNorm: "action example" });
  const row = await insertJob(db(), { companyId: company.id, title: "Platform Engineer", titleNorm: "platform engineer", description: "Build reliable services using TypeScript.", language: "en" });
  await db().insert(schema.scores).values({ jobId: row.id, profileSnapshotId: snapshotId, filterResult: "passed", filterReasons: [] });
  return row;
}

async function connect(options: { permissions?: Permission[]; budgets?: Record<string, unknown>; caller?: number; writable?: boolean } = {}) {
  const granted = options.permissions ?? permissions;
  const settings = mcpSchema.parse({ enabled: true, permissions: granted, stdio: { permissions: granted }, budgets: options.budgets });
  const audit = createAuditRecorder(() => {
    const connection = createConnection(url, { max: 1 });
    return { db: connection.db, end: (opts: { timeout: number }) => connection.sql.end(opts) };
  }, { text: mcpTranslator("en"), log: () => undefined, writeTimeoutMs: 5000 });
  const ctx = defaultContext(readOnly.db, settings, {
    readSettings: () => settings, text: mcpTranslator("en"), log: () => undefined,
    actionDb: options.writable === false ? undefined : db(), audit,
    caller: { caller: "stdio", tokenId: options.caller ?? null, transport: "stdio" },
  });
  ctx.now = () => NOW;
  ctx.timezone = () => "Europe/Berlin";
  const server = buildServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "actions-integration", version: "1.0.0" });
  await client.connect(clientTransport);
  closes.push(async () => { await client.close(); await server.close(); await audit.close(); });
  const call = async <T = ActionOutput>(name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return { data: result.structuredContent as T, error: result.isError === true, text: (result.content as { text?: string }[]).map((item) => item.text ?? "").join("\n") };
  };
  const usage = () => readAgentBudget(db(), options.caller ?? "stdio", { budgets: () => settings.budgets, timeZone: ctx.timezone, now: ctx.now });
  return { client, ctx, settings, call, usage };
}

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
  readOnly = createReadOnlyDb({ url, connectTimeoutSeconds: 30 });
});
beforeEach(async () => {
  temp = tempCareer();
  setting("breakdown", ["enabled"], true);
  setting("research", ["enabled"], true);
  setting("research", ["company", "max_per_day"], 100);
  setting("salary", ["lookup", "enabled"], true);
  setting("salary", ["lookup", "max_per_day"], 100);
  setting("ai", ["tasks", "salary_lookup", "order"], ["codex-cli"]);
  setting("ai", ["tasks", "company_research", "order"], ["codex-cli"]);
  setting("ai", ["providers", "codex_cli", "enabled"], true);
  setting("ai", ["scoring", "backlog_per_run"], 7);
  setting("sources", ["collect", "max_backfill_hours"], 24);
  fs.writeFileSync(path.join(temp.configDir, "writer.yaml"), stringify({ config_version: 1, ...writerSchema.parse({ enabled: true, draft_max_chars: 500 }) }));
  const [snapshot] = await db().insert(schema.profileSnapshots).values({ kind: "preferences", contentYaml: "{}", hash: "fixture" }).returning();
  snapshotId = snapshot!.id;
});
afterEach(async () => {
  for (const close of closes) await close();
  closes = [];
  vi.restoreAllMocks();
  temp.cleanup();
});
afterAll(async () => { await readOnly.close(); await closeDb(); });

it.each([
  ["run_collection", "run_cycle"], ["score_jobs", "score_jobs"], ["translate_job", "translate_job"],
  ["breakdown_job", "breakdown_job"], ["research_salary", "salary_lookup"], ["research_company", "company_research"],
] as const)("%s queues the right payload through a real MCP client", async (tool, kind) => {
  const target = await job();
  const session = await connect();
  const args = tool === "run_collection" ? { channel_ids: ["indeed"] } : tool === "score_jobs" ? { job_ids: [target.id] } : { job_id: target.id, force: true };
  const result = await session.call(tool, args);
  expect(result.error, result.text).toBe(false);
  expect(result.data).toMatchObject({ state: "queued", existing: false, budget: { action: tool } });
  const row = await getControlRequest(db(), result.data.request_id!);
  expect(row).toMatchObject({ kind, payload: { caller: "stdio", ...(tool === "run_collection" ? { channelIds: ["indeed"] } : tool === "score_jobs" ? { jobIds: [target.id] } : { jobId: target.id, force: true }) } });
  expect((await session.usage()).actions[tool].used).toBe(1);
});

it.each(["draft", "polish"] as const)("draft_answer queues %s material and retains existing payload scrubbing", async (mode) => {
  const target = await job();
  const question = await createApplicationQuestion(db(), { maxPerJob: 10, fields: { jobId: target.id, text: "Why this role?", kind: "question", lengthUnit: "words", lengthValue: 150, outputLanguage: "en", tone: "neutral", selectedMaterials: { jdPoints: [], useJdText: true, storyIds: [], profile: false, emphasis: "SENTINEL-MATERIAL" } } });
  const session = await connect();
  const result = await session.call("draft_answer", { job_id: target.id, question_id: question!.id, mode, ...(mode === "polish" ? { option: "language_only", text: "SENTINEL-DRAFT" } : {}) });
  expect(result.error, result.text).toBe(false);
  expect(await getControlRequest(db(), result.data.request_id!)).toMatchObject({ kind: "writer_job", payload: { caller: "stdio", jobId: target.id, questionId: question!.id, mode, materials: expect.any(Object) } });
  await claimNextControlRequest(db(), ["writer_job"]);
  await finishControlRequest(db(), result.data.request_id!, { status: "done", result: {} });
  const row = await getControlRequest(db(), result.data.request_id!);
  expect(row?.payload).toMatchObject({ caller: "stdio", scrubbed: true });
  expect(row?.payload).not.toHaveProperty("materials");
  const audit = await db().select().from(schema.agentCalls);
  expect(audit[0]).toMatchObject({ outcome: "ok", targetType: "question", targetId: question!.id });
  expect(JSON.stringify(audit)).not.toContain("SENTINEL");
});

it("hides all eight without actions:run and names missing secondary permissions on direct calls", async () => {
  const absent = await connect({ permissions: ["writer:write"] });
  expect((await absent.client.listTools()).tools.map((tool) => tool.name).filter((name) => actions.includes(name))).toEqual([]);
  expect((await absent.call("translate_job", { job_id: 1 })).text).toContain("actions:run");
  const basic = await connect({ permissions: ["actions:run"] });
  const names = (await basic.client.listTools()).tools.map((tool) => tool.name);
  expect(names).not.toContain("draft_answer");
  expect((await basic.call("draft_answer", { job_id: 1, question_id: 1, mode: "draft" })).text).toContain("writer:write");
});

it.each([
  ["breakdown_job", "breakdown", ["enabled"]], ["research_salary", "salary", ["lookup", "enabled"]],
  ["research_company", "research", ["enabled"]], ["draft_answer", "writer", ["enabled"]],
] as const)("%s disappears when its live feature gate closes and takes no budget", async (tool, file, keys) => {
  const session = await connect();
  expect((await session.client.listTools()).tools.map((item) => item.name)).toContain(tool);
  setting(file, [...keys], false);
  expect((await session.client.listTools()).tools.map((item) => item.name)).not.toContain(tool);
  const args = tool === "draft_answer" ? { job_id: 1, question_id: 1, mode: "draft" } : { job_id: 1 };
  expect((await session.call(tool, args)).text).toContain("disabled");
  expect(await db().select().from(schema.agentBudgetTickets)).toHaveLength(0);
  expect(await db().select().from(schema.agentBudgetUsage)).toHaveLength(0);
});

it("offers no action triggers without their write connection", async () => {
  const session = await connect({ writable: false });
  expect((await session.client.listTools()).tools.map((item) => item.name)).toEqual(["get_request_status"]);
  expect((await session.call("translate_job", { job_id: 1 })).text).toContain("disabled");
  expect((await session.usage()).total.used).toBe(0);
});

it("refuses at the cap with action, cap and local reset; the next local day works", async () => {
  const first = await job();
  const second = await job();
  const session = await connect({ budgets: { per_caller: { translate_job: 1 }, total: 10 } });
  expect((await session.call("translate_job", { job_id: first.id })).error).toBe(false);
  const refused = await session.call("translate_job", { job_id: second.id });
  expect(refused.error).toBe(true);
  for (const value of ["translate_job", "cap 1", "remaining 0", "2026-11-12 00:00", "Europe/Berlin"]) expect(refused.text).toContain(value);
  session.ctx.now = () => new Date("2026-11-11T23:01:00Z");
  expect((await session.call("translate_job", { job_id: second.id })).error).toBe(false);
  expect((await session.usage()).actions.translate_job.used).toBe(1);
  const audit = await db().select().from(schema.agentCalls).orderBy(schema.agentCalls.id);
  expect(audit.map((row) => row.outcome)).toEqual(["ok", "over_budget", "ok"]);
  expect(audit[1]?.errorCategory).toBeNull();
  expect(audit.every((row) => !Object.hasOwn(row, "arguments"))).toBe(true);
});

it("refuses cap zero before queuing", async () => {
  const target = await job();
  const session = await connect({ budgets: { per_caller: { translate_job: 0 } } });
  const refused = await session.call("translate_job", { job_id: target.id });
  expect(refused.error).toBe(true);
  expect(refused.text).toContain("cap 0");
  expect(await db().select().from(schema.controlRequests)).toHaveLength(0);
});

it("permits exactly N new requests from 2N concurrent submissions", async () => {
  const cap = 3;
  const jobs = await Promise.all(Array.from({ length: cap * 2 }, job));
  const session = await connect({ budgets: { per_caller: { translate_job: cap }, total: 20 } });
  const results = await Promise.all(jobs.map((target) => session.call("translate_job", { job_id: target.id })));
  expect(results.filter((result) => !result.error)).toHaveLength(cap);
  expect(await db().select().from(schema.controlRequests)).toHaveLength(cap);
  expect((await session.usage()).actions.translate_job.used).toBe(cap);
});

it("joins a web request and hits a translation cache without charging either counter or changing ownership", async () => {
  const target = await job();
  const web = await requestTranslateJob(db(), { jobId: target.id, force: false, origin: "user" });
  const session = await connect();
  const joined = await session.call("translate_job", { job_id: target.id });
  expect(joined.data.state).toBe("joined_existing");
  expect(web.state === "queued" && joined.data.request_id).toBe(web.state === "queued" ? web.requestId : null);
  expect((await session.call("get_request_status", { request_id: joined.data.request_id })).text).toBe("Request not found.");
  await upsertTranslation(db(), { jobId: target.id, lang: "zh", provider: null, content: "SENTINEL-CACHED", sourceHash: descriptionHash(target.description!) });
  const cached = await session.call("translate_job", { job_id: target.id });
  expect(cached.data).toMatchObject({ state: "cached", request_id: null, existing: false });
  expect(cached.text).not.toContain("SENTINEL");
  expect((await session.usage()).total.used).toBe(0);
  expect((await session.usage()).actions.translate_job.used).toBe(0);
});

it("scores by job count, refuses an entire batch and reserves the configured backlog size", async () => {
  const targets = await Promise.all(Array.from({ length: 5 }, job));
  const session = await connect({ budgets: { per_caller: { score_jobs: 3 }, total: 20 } });
  const result = await session.call("score_jobs", { job_ids: targets.slice(0, 2).map((row) => row.id) });
  expect(result.error, result.text).toBe(false);
  expect(result.data.budget.remaining).toBe(1);
  const refused = await session.call("score_jobs", { job_ids: targets.slice(2, 4).map((row) => row.id) });
  expect(refused.error).toBe(true);
  expect(refused.text).toContain("remaining 1");
  expect((await session.usage()).total.used).toBe(1);
  const other = await connect({ caller: 7, budgets: { per_caller: { score_jobs: 9 }, total: 20 } });
  const backlog = await other.call("score_jobs", { backlog: true });
  expect(backlog.error, backlog.text).toBe(false);
  expect(backlog.data.budget.remaining).toBe(2);
  expect(await getControlRequest(db(), backlog.data.request_id!)).toMatchObject({ payload: { backlog: true, caller: 7 } });
});

it("reserves the fresh backlog size when scoring settings change between requests", async () => {
  await job();
  const session = await connect({ budgets: { per_caller: { score_jobs: 18 }, total: 20 } });
  process.env.JOB_RADAR_CONFIG_POLL_MS = "0";
  const first = await session.call("score_jobs", { backlog: true });
  expect(first.data.budget.remaining).toBe(11);
  await finishControlRequest(db(), first.data.request_id!, { status: "done" });
  setting("ai", ["scoring", "backlog_per_run"], 11, false);
  const second = await session.call("score_jobs", { backlog: true });
  expect(second.error, second.text).toBe(false);
  expect(second.data.budget.remaining).toBe(0);
  expect((await session.usage()).actions.score_jobs.used).toBe(18);
});

it("validates against the same live draft length advertised by tools/list", async () => {
  const target = await job();
  const question = await createApplicationQuestion(db(), { maxPerJob: 10, fields: { jobId: target.id, text: "Why this role?", kind: "question", lengthUnit: "words", lengthValue: 150, outputLanguage: "en", tone: "neutral", selectedMaterials: {} } });
  const session = await connect();
  const args = { job_id: target.id, question_id: question!.id, mode: "polish", option: "language_only", text: "x".repeat(600) };
  expect((await session.call("draft_answer", args)).error).toBe(true);
  setting("writer", ["draft_max_chars"], 700, false);
  const listed = (await session.client.listTools()).tools.find((tool) => tool.name === "draft_answer");
  expect(listed?.inputSchema.properties).toMatchObject({ text: { maxLength: 700 } });
  const accepted = await session.call("draft_answer", args);
  expect(accepted.error, accepted.text).toBe(false);
  setting("writer", ["draft_max_chars"], 500, false);
  expect((await session.call("draft_answer", args)).error).toBe(true);
  expect((await session.usage()).actions.draft_answer.used).toBe(1);
  await session.ctx.audit?.close();
  const audit = await db().select().from(schema.agentCalls).orderBy(schema.agentCalls.id);
  expect(audit.map((row) => row.outcome)).toEqual(["invalid_input", "ok", "invalid_input"]);
});

it("separates caller budgets and refuses both callers at the shared total", async () => {
  const one = await connect({ budgets: { per_caller: { translate_job: 2 }, total: 3 } });
  const two = await connect({ caller: 7, budgets: { per_caller: { translate_job: 2 }, total: 3 } });
  for (const session of [one, two, two]) expect((await session.call("translate_job", { job_id: (await job()).id })).error).toBe(false);
  expect((await one.usage()).actions.translate_job.used).toBe(1);
  expect((await two.usage()).actions.translate_job.used).toBe(2);
  two.settings.budgets.per_caller.translate_job = 3;
  for (const session of [one, two]) {
    const refused = await session.call("translate_job", { job_id: (await job()).id });
    expect(refused.error).toBe(true);
    expect(refused.text).toContain("total budget");
  }
});

it.each(["pending", "running", "done", "failed"] as const)("get_request_status returns %s with only allowed results and timestamps", async (status) => {
  const session = await connect();
  const request = await insertControlRequest(db(), { kind: "score_jobs", payload: { caller: "stdio", jobIds: [1], text: "SENTINEL-PAYLOAD" } });
  await db().update(schema.controlRequests).set({ status, startedAt: status === "pending" ? null : NOW, finishedAt: status === "done" || status === "failed" ? NOW : null, result: { error: "quota_guard", resumeAt: "2026-11-12T00:00:00Z", scored: 2, failed: 1, remaining: 5, fetched: 8, new: 3, stopped: "time_budget", detail: "SENTINEL-DETAIL", text: "SENTINEL-RESULT" } }).where(eq(schema.controlRequests.id, request.id));
  const result = await session.call<RequestStatusOutput>("get_request_status", { request_id: request.id });
  expect(result.error, result.text).toBe(false);
  expect(result.data).toMatchObject({ status, request_id: request.id, result: { error: "quota_guard", scored: 2, failed: 1, remaining: 5, fetched: 8, new: 3, stopped: "time_budget", resume_at: "2026-11-12T00:00:00Z" } });
  expect(result.data.ahead).toBe(status === "pending" || status === "running" ? 0 : null);
  expect(result.data.worker_online).toBe(status === "pending" || status === "running" ? false : null);
  expect(result.text).not.toContain("SENTINEL");
  expect((await session.usage()).total.used).toBe(0);
  const audit = await db().select().from(schema.agentCalls);
  expect(audit[0]).toMatchObject({ capability: "get_request_status", outcome: "ok", targetId: null });
  expect(JSON.stringify(audit)).not.toContain("SENTINEL");
});

it("returns identical not found responses for another caller, web, scheduler and unsupported kinds", async () => {
  const session = await connect();
  for (const input of [
    { kind: "translate_job" as const, payload: { jobId: 1, caller: 7 } },
    { kind: "translate_job" as const, payload: { jobId: 1 } },
    { kind: "run_ai" as const, payload: { cycleId: 1 } },
    { kind: "models_sync" as const, payload: { caller: "stdio" } },
    { kind: "score_jobs" as const, payload: { caller: "7", backlog: true } },
  ]) {
    const row = await insertControlRequest(db(), input);
    const result = await session.call("get_request_status", { request_id: row.id });
    expect(result.error).toBe(true);
    expect(result.text).toBe("Request not found.");
  }
  expect((await session.call("get_request_status", { request_id: 999999 })).text).toBe("Request not found.");
});

it("keeps collection deduplication and backfill gates identical to the web", async () => {
  const session = await connect({ budgets: { per_caller: { run_collection: 10 } } });
  const first = await session.call("run_collection", { channel_ids: ["indeed"] });
  const web = await requestRunCycle({ channelIds: ["indeed"] }, { db: db() });
  expect(web).toMatchObject({ status: "queued", request: first.data.request_id, existing: true });
  expect((await session.call("run_collection", { channel_ids: ["indeed"] })).data.state).toBe("joined_existing");
  expect(await requestRunCycle({ backfillHours: 2 }, { db: db() })).toMatchObject({ status: "error", error: "cycleBusy" });
  expect((await session.call("run_collection", { backfill_hours: 2 })).text).toContain("already queued");
  expect(await requestRunCycle({ backfillHours: 25 }, { db: db() })).toMatchObject({ status: "error", error: "backfillOverLimit" });
  expect((await session.call("run_collection", { backfill_hours: 25 })).text).toContain("max_backfill_hours");
  expect((await session.usage()).actions.run_collection.used).toBe(1);
});

it("keeps the processing cycle lock authoritative for both web and agent payloads", async () => {
  const session = await connect();
  const release = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<number>();
  const held = withCycleLock(db(), "try", async (holder) => {
    const cycle = await createCycle(db(), { kind: "manual", summary: { channelIds: ["arbeitsagentur"], lockPid: holder.pid } });
    ready.resolve(cycle.id);
    await release.promise;
    await finishCycle(db(), cycle.id, { status: "succeeded" });
  });
  try {
    await Promise.race([ready.promise, held.then(() => { throw new Error("cycle lock unavailable"); })]);
    const queued = await session.call("run_collection", { channel_ids: ["indeed"] });
    const row = await getControlRequest(db(), queued.data.request_id!);
    if (!row) throw new Error("expected request");
    const context = { db: db(), signal: new AbortController().signal, logger: quietLogger };
    const agent = await runCycleHandler(row, context);
    const web = await runCycleHandler({ ...row, payload: { channelIds: ["indeed"] } }, context);
    expect(agent).toMatchObject({ status: "failed", result: { error: "another_cycle_running" } });
    expect(web).toMatchObject({ status: "failed", result: { error: "another_cycle_running" } });
    await finishControlRequest(db(), row.id, agent);
    expect((await session.call<RequestStatusOutput>("get_request_status", { request_id: row.id })).data.result.error).toBe("another_cycle_running");
  } finally {
    release.resolve();
    await held;
  }
});

it("returns collection progress and live queue position without disclosing other requests", async () => {
  const session = await connect();
  await writeHeartbeat(db(), "runner");
  await insertControlRequest(db(), { kind: "run_cycle", payload: { private: "SENTINEL-OTHER" } });
  const mine = await insertControlRequest(db(), { kind: "run_cycle", payload: { caller: "stdio" } });
  const pending = await session.call<RequestStatusOutput>("get_request_status", { request_id: mine.id });
  expect(pending.data).toMatchObject({ ahead: 1, worker_online: true, cycle: null });
  const cycle = await createCycle(db(), { kind: "manual", summary: {} });
  await db().update(schema.controlRequests).set({ status: "running", startedAt: NOW, result: { cycleId: cycle.id } }).where(eq(schema.controlRequests.id, mine.id));
  const running = await session.call<RequestStatusOutput>("get_request_status", { request_id: mine.id });
  expect(running.data.cycle).toEqual({ id: cycle.id, status: "running", runs_total: 0, runs_finished: 0, fetched: 0, new: 0 });
  expect(running.text).not.toContain("SENTINEL");
});

it.each(["research_salary", "research_company"] as const)("%s preserves its existing quota and refunds an enqueue error", async (tool) => {
  const target = await job();
  setting(tool === "research_salary" ? "salary" : "research", [tool === "research_salary" ? "lookup" : "company", "max_per_day"], 1);
  await insertControlRequest(db(), { kind: tool === "research_salary" ? "salary_lookup" : "company_research", payload: {} });
  const session = await connect();
  const web = tool === "research_salary"
    ? await requestSalaryLookup(db(), { jobId: target.id, force: true, ...readSalaryActionSettings() })
    : await requestCompanyResearch(db(), { jobId: target.id, force: true, ...readCompanyActionSettings() });
  expect(web).toMatchObject({ state: "error", error: "quota" });
  expect((await session.call(tool, { job_id: target.id, force: true })).text).toContain("quota");
  expect((await session.usage()).total.used).toBe(0);
});

it("refunds exceptions and error outcomes, while the indirect budget function still works", async () => {
  const session = await connect();
  await expect(runAction(session.ctx, "translate_job", async () => { throw new Error("sentinel"); })).rejects.toThrow("sentinel");
  expect((await session.call("translate_job", { job_id: 999999 })).error).toBe(true);
  expect((await session.usage()).total.used).toBe(0);
  expect(await db().select().from(schema.agentBudgetTickets)).toHaveLength(0);
  const deps = { budgets: () => session.settings.budgets, timeZone: session.ctx.timezone, now: session.ctx.now };
  expect(await takeIndirectBudget(db(), { caller: "stdio", action: "research_company" }, deps)).toMatchObject({ decision: "go" });
  session.settings.budgets.per_caller.research_company = 0;
  expect(await takeIndirectBudget(db(), { caller: "stdio", action: "research_company" }, deps)).toMatchObject({ decision: "skip" });
});

it("strips a web-supplied caller and uses only the separate server argument", async () => {
  const target = await job();
  const cycle = await requestRunCycle({ channelIds: ["indeed"], caller: 88 }, { db: db() });
  const score = await requestScoreJobs({ jobIds: [target.id], caller: 88 }, { db: db() });
  const models = await requestModelsSync({ provider: "openrouter", caller: 88 }, { db: db() });
  for (const result of [cycle, score, models]) {
    expect(result.status, JSON.stringify(result)).toBe("queued");
    if (result.status === "queued") expect((await getControlRequest(db(), result.request))?.payload).not.toHaveProperty("caller");
  }
  const session = await connect({ caller: 7 });
  expect((await session.usage()).total.used).toBe(0);
  expect((await session.call("run_collection", { caller: 88 })).error).toBe(true);
});

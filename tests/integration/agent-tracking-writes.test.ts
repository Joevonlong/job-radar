import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { markAppliedAction, setApplicationStatusAction } from "@/app/jobs/[id]/actions";
import { saveNextActionAction, setInterviewRoundsAction, undoApplicationStatusAction } from "@/app/pipeline/actions";
import { createAuditRecorder, type AuditRecorder } from "@/lib/agent-access/audit";
import type { AgentCaller } from "@/lib/agent-access/caller";
import type { Permission } from "@/lib/agent-access/permissions";
import { valueFingerprint, writeWithUndo, type AgentWriteAccess, type UndoKind } from "@/lib/agent-access/write";
import { applicationUndoKinds } from "@/lib/applications/undo";
import { CAPABILITIES } from "@/lib/capabilities/registry";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import { closeDb, createConnection, getDb, schema } from "@/lib/db";
import { createReadOnlyDb, type ReadOnlyDb } from "@/lib/db/read-only-client";
import { pruneAgentCalls } from "@/lib/db/repos/agent-calls";
import { getAgentCallUndoState } from "@/lib/db/repos/agent-undo";
import { getApplicationByJobId, listApplicationEvents, setApplicationNotes, setApplicationStatus, type ApplicationStatus } from "@/lib/db/repos/applications";
import { readApplicationForUndo } from "@/lib/db/repos/application-undo";
import { getOrCreateCompany } from "@/lib/db/repos/companies";
import { insertJob } from "@/lib/db/repos/jobs";
import { runLogged } from "@/lib/mcp/context";
import { getJobOutput, trackingWriteOutput, undoChangeOutput } from "@/lib/mcp/dto";
import { getApplicationOutput } from "@/lib/mcp/dto/read-tracking";
import { buildServer, defaultContext } from "@/lib/mcp/server";
import { mcpTranslator } from "@/lib/mcp/text";
import { makeTempConfig } from "../config/helpers";
import { trackingResearchDeps } from "./tracking-write-fixtures";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const pending = new Set<Promise<unknown>>();
vi.mock("@/lib/research/auto", async (original) => {
  const actual = await original<typeof import("@/lib/research/auto")>();
  return { ...actual, triggerAutoResearch: (db: Parameters<typeof actual.requestAutoResearch>[0], input: Parameters<typeof actual.requestAutoResearch>[1]) => {
    const request = actual.requestAutoResearch(db, input, trackingResearchDeps());
    pending.add(request);
    void request.finally(() => pending.delete(request));
    return request;
  } };
});
vi.mock("@/lib/agent-access/authorize", async (original) => ({ ...await original<typeof import("@/lib/agent-access/authorize")>(), liveMcpSettings: () => settings() }));
const url = inject("testDatabaseUrl");
const text = mcpTranslator("en");
let cap = 100;
const settings = () => mcpSchema.parse({ enabled: true, permissions: ["tracking:write"], stdio: { permissions: ["tracking:write"] }, budgets: { per_caller: { research_company: cap }, total: 100 } });
let audit: AuditRecorder;
let readOnly: ReadOnlyDb;
let serial = 0;

beforeAll(() => {
  process.env.DATABASE_URL = url;
  readOnly = createReadOnlyDb({ url });
  audit = createAuditRecorder(() => ({ db: getDb(), end: async () => undefined }), { text, log: () => undefined, writeTimeoutMs: 3000 });
});
beforeEach(async () => {
  cap = 100;
  // agent_calls.token_id references agent_tokens: the callers 12 and 13 used below are real token rows (the tables are emptied before each test)
  for (const id of [12, 13]) await getDb().execute(sql`insert into agent_tokens (id, name, token_hash, token_prefix, permissions) overriding system value values (${id}, ${`token ${id}`}, ${`hash-${id}`}, ${`jrt_${id}`}, array['tracking:write'])`);
});
afterAll(async () => {
  await Promise.all(pending);
  await audit.close();
  await readOnly.close();
  await closeDb();
});

async function fixture(status: ApplicationStatus | null = "new") {
  serial++;
  const company = await getOrCreateCompany(getDb(), { name: `Example ${serial}`, nameNorm: `example ${serial}` });
  const job = await insertJob(getDb(), { companyId: company.id, title: "Engineer", titleNorm: "engineer", description: "Build reliable systems." });
  if (status !== null) {
    await setApplicationStatus(getDb(), job.id, status);
    await setApplicationNotes(getDb(), job.id, "PRIVATE-NOTE-PRESERVED");
  }
  await getDb().update(schema.jobs).set({ dormantAt: new Date("2026-01-01T00:00:00Z") }).where(eq(schema.jobs.id, job.id));
  return job.id;
}

async function call(name: string, args: unknown, caller: AgentCaller = "stdio", permissions: Permission[] = ["tracking:write"]) {
  const capability = CAPABILITIES.find((item) => item.id === name)!;
  const ctx = defaultContext(readOnly.db, settings(), { trackingWriteDb: getDb(), readSettings: settings, text, log: () => undefined, audit, caller: { caller: typeof caller === "number" ? "token" : "stdio", tokenId: typeof caller === "number" ? caller : null, transport: caller === "stdio" ? "stdio" : "http" } });
  const input = capability.input(ctx).parse(args);
  return runLogged(ctx, name, async (current) => ({ result: await capability.handler({ ...current, permissions: new Set(permissions) }, input), count: 1 }), capability.target?.(input) ?? null);
}
async function write(name: string, args: unknown, caller: AgentCaller = "stdio") {
  return trackingWriteOutput.parse(await call(name, args, caller));
}
async function undo(id: number, caller: AgentCaller = "stdio") {
  return undoChangeOutput.parse(await call("undo_change", { audit_id: id }, caller));
}
async function snapshot(jobId: number) {
  const app = await getApplicationByJobId(getDb(), jobId);
  const events = app ? await listApplicationEvents(getDb(), app.id) : [];
  const [job] = await getDb().select({ dormantAt: schema.jobs.dormantAt }).from(schema.jobs).where(eq(schema.jobs.id, jobId));
  const requests = await getDb().select().from(schema.controlRequests);
  return {
    status: app?.status, notes: app?.notesMd, nextAction: app?.nextAction, nextActionAt: app?.nextActionAt, interviewRounds: app?.interviewRounds,
    events: events.map((event) => ({ from: event.fromStatus, to: event.toStatus, note: event.note })), dormantAt: job.dormantAt,
    queued: requests.filter((row) => (row.payload as { jobId?: number }).jobId === jobId).map((row) => ({ kind: row.kind, origin: (row.payload as { origin?: string }).origin })),
  };
}
const operations = [
  { tool: "set_application_status", args: { status: "applied" }, web: (jobId: number) => setApplicationStatusAction({ jobId, status: "applied" }), owner: (jobId: number) => setApplicationStatusAction({ jobId, status: "offer" }), field: "application_status" },
  { tool: "mark_applied", args: {}, web: (jobId: number) => markAppliedAction({ jobId }), owner: (jobId: number) => setApplicationStatusAction({ jobId, status: "offer" }), field: "application_status" },
  { tool: "set_next_action", args: { next_action: " Send CV ", next_action_date: "2026-12-24" }, web: (jobId: number) => saveNextActionAction({ jobId, nextAction: " Send CV ", nextActionDate: "2026-12-24" }), owner: (jobId: number) => saveNextActionAction({ jobId, nextAction: "Owner choice", nextActionDate: null }), field: "next_action" },
  { tool: "set_interview_rounds", args: { rounds: 3 }, web: (jobId: number) => setInterviewRoundsAction({ jobId, rounds: 3 }), owner: (jobId: number) => setInterviewRoundsAction({ jobId, rounds: 7 }), field: "interview_rounds" },
];

describe.each(operations)("$tool", (operation) => {
  it("matches web state, history, research queue and dormancy side effects", async () => {
    const webId = await fixture();
    const agentId = await fixture();
    expect(await operation.web(webId)).toMatchObject({ ok: true });
    await Promise.all(pending);
    const receipt = await write(operation.tool, { job_id: agentId, ...operation.args });
    expect(receipt.undoable).toBe(true);
    expect(await snapshot(agentId)).toEqual(await snapshot(webId));
    const rows = await getDb().select().from(schema.agentCalls);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: receipt.audit_id, capability: operation.tool, targetType: "job", targetId: agentId });
    expect(await getAgentCallUndoState(getDb(), receipt.audit_id)).toBe("undoable");
    if (operation.field === "application_status") expect((await snapshot(agentId)).queued).toEqual([{ kind: "company_research", origin: "auto" }]);
  });

  it("restores the field once, appending status history and leaving notes intact", async () => {
    const id = await fixture();
    const before = await snapshot(id);
    const receipt = await write(operation.tool, { job_id: id, ...operation.args });
    const result = await undo(receipt.audit_id);
    expect(result.field).toBe(operation.field);
    expect(JSON.stringify(result)).not.toContain("PRIVATE-NOTE-PRESERVED");
    const after = await snapshot(id);
    expect({ status: after.status, nextAction: after.nextAction, nextActionAt: after.nextActionAt, interviewRounds: after.interviewRounds, notes: after.notes })
      .toEqual({ status: before.status, nextAction: before.nextAction, nextActionAt: before.nextActionAt, interviewRounds: before.interviewRounds, notes: before.notes });
    expect(after.events.length).toBe(before.events.length + (operation.field === "application_status" ? 2 : 0));
    if (operation.field === "application_status") expect(after.events[0]).toEqual({ from: "applied", to: "new", note: null });
    expect(await getAgentCallUndoState(getDb(), receipt.audit_id)).toBe("undone");
    expect(await getAgentCallUndoState(getDb(), result.audit_id)).toBe("not_undoable");
    expect(await call("undo_change", { audit_id: receipt.audit_id })).toMatchObject({ isError: true });
    expect(await call("undo_change", { audit_id: result.audit_id })).toMatchObject({ isError: true });
    expect((await snapshot(id)).events).toEqual(after.events);
  });

  it("refuses a conflict without overwriting the owner's later edit", async () => {
    const id = await fixture();
    const receipt = await write(operation.tool, { job_id: id, ...operation.args });
    expect(await operation.owner(id)).toMatchObject({ ok: true });
    await Promise.all(pending);
    const owner = await snapshot(id);
    const failure = await call("undo_change", { audit_id: receipt.audit_id });
    expect(failure).toMatchObject({ isError: true });
    expect(JSON.stringify(failure)).toContain(text("errors.undo.conflict"));
    expect(await snapshot(id)).toEqual(owner);
    expect(await getAgentCallUndoState(getDb(), receipt.audit_id)).toBe("undoable");
  });

  it("refuses another caller and a missing original write permission", async () => {
    const id = await fixture();
    const receipt = await write(operation.tool, { job_id: id, ...operation.args }, 12);
    const after = await snapshot(id);
    expect(await call("undo_change", { audit_id: receipt.audit_id }, 13)).toMatchObject({ isError: true });
    expect(await call("undo_change", { audit_id: receipt.audit_id }, 12, ["notes:write"])).toMatchObject({ isError: true });
    expect(await snapshot(id)).toEqual(after);
    expect(await undo(receipt.audit_id, 12)).toMatchObject({ field: operation.field });
  });
});

it.each(["agent_calls", "agent_undo"] as const)("rolls back business data, events, queued research and budget if %s insert fails", async (table) => {
  const id = await fixture();
  const before = await snapshot(id);
  await getDb().execute(sql.raw(`alter table ${table} add constraint test_refuse_write check (false) not valid`));
  try {
    expect(await call("set_application_status", { job_id: id, status: "applied" })).toMatchObject({ isError: true });
    expect(await snapshot(id)).toEqual(before);
    expect(await getDb().select().from(schema.agentUndo)).toHaveLength(0);
    expect(await getDb().select().from(schema.agentBudgetUsage)).toHaveLength(0);
  } finally {
    await getDb().execute(sql.raw(`alter table ${table} drop constraint test_refuse_write`));
  }
});

it("prunes local undo values with expired audit rows, preserving recent rows", async () => {
  const first = await fixture();
  const second = await fixture();
  const old = await write("set_interview_rounds", { job_id: first, rounds: 1 });
  const recent = await write("set_interview_rounds", { job_id: second, rounds: 2 });
  await getDb().update(schema.agentCalls).set({ calledAt: new Date("2020-01-01Z") }).where(eq(schema.agentCalls.id, old.audit_id));
  expect(await pruneAgentCalls(getDb(), new Date("2021-01-01Z"))).toBe(1);
  expect((await getDb().select().from(schema.agentUndo)).map((row) => row.auditId)).toEqual([recent.audit_id]);
});

it("budget refusal keeps the status write, tells the caller, and leaves owner research uncharged", async () => {
  cap = 0;
  const id = await fixture();
  const receipt = await write("mark_applied", { job_id: id });
  expect(receipt.research).toBe("budget_skipped");
  expect(receipt.notices).toEqual([text("notice.researchBudgetSkipped")]);
  expect((await snapshot(id)).status).toBe("applied");
  expect((await snapshot(id)).queued).toEqual([]);
  const ownerId = await fixture();
  await markAppliedAction({ jobId: ownerId });
  await Promise.all(pending);
  expect((await snapshot(ownerId)).queued).toHaveLength(1);
  expect(await getDb().select().from(schema.agentBudgetUsage)).toHaveLength(0);
});

it("a granted research ticket counts one unit and duplicate queued work gives it back", async () => {
  const id = await fixture();
  await write("mark_applied", { job_id: id });
  const usage = await getDb().select().from(schema.agentBudgetUsage);
  expect(usage.map((row) => ({ caller: row.caller, used: row.used }))).toEqual(expect.arrayContaining([{ caller: "stdio", used: 1 }, { caller: "*", used: 1 }]));
  await getDb().delete(schema.researchAutoRuns);
  await setApplicationStatus(getDb(), id, "new");
  await write("mark_applied", { job_id: id });
  expect((await getDb().select().from(schema.agentBudgetUsage)).map((row) => row.used)).toEqual([1, 1]);
  expect((await snapshot(id)).queued).toHaveLength(1);
});

it("mark applied refuses later stages clearly; repeated application is a non-undoable no-op", async () => {
  const id = await fixture("offer");
  const before = await snapshot(id);
  const refused = await call("mark_applied", { job_id: id });
  expect(refused).toMatchObject({ isError: true });
  expect(JSON.stringify(refused)).toContain(text("errors.markAppliedNotAllowed"));
  expect(await snapshot(id)).toEqual(before);
  await setApplicationStatus(getDb(), id, "applied");
  const after = await snapshot(id);
  const receipt = await write("mark_applied", { job_id: id });
  expect(receipt).toMatchObject({ undoable: false, research: null });
  expect(await snapshot(id)).toEqual(after);
  expect(await call("undo_change", { audit_id: receipt.audit_id })).toMatchObject({ isError: true });
});

describe("mark_applied through MCP", () => {
  const now = new Date("2026-11-18T16:30:00Z");
  const dateTime = "2026-11-12T09:30:00+01:00";
  const occurredAt = "2026-11-12T08:30:00.000Z";
  const recorded = { applied_at: dateTime, reference: "receipt-17" };
  let temp: ReturnType<typeof makeTempConfig>;
  let close: (() => Promise<void>) | undefined;

  beforeAll(() => {
    temp = makeTempConfig({ user: "empty" });
    fs.writeFileSync(path.join(temp.configDir, "schedule.yaml"), "timezone: Asia/Tokyo\n");
  });
  afterEach(async () => { await close?.(); close = undefined; });
  afterAll(() => temp.cleanup());

  async function connect(locale: "en" | "zh" = "en") {
    const text = mcpTranslator(locale);
    const permissions: Permission[] = ["jobs:read", "tracking:read", "tracking:write"];
    const config = mcpSchema.parse({ ...settings(), permissions, stdio: { permissions } });
    const recorder = createAuditRecorder(() => ({ db: getDb(), end: async () => undefined }), { text, log: () => undefined, writeTimeoutMs: 3000 });
    const ctx = defaultContext(readOnly.db, config, { trackingWriteDb: getDb(), readSettings: () => config, text, log: () => undefined, audit: recorder });
    ctx.now = () => now;
    const server = buildServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "mark-applied-test", version: "1.0.0" });
    close = async () => { await client.close(); await server.close(); await recorder.close(); };
    await server.connect(st);
    await client.connect(ct);
    return client;
  }

  async function invoke(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent;
  }

  async function read(client: Client, jobId: number) {
    const result = getApplicationOutput.parse(await invoke(client, "get_application", { job_id: jobId }));
    expect(result.tracking.application).not.toBeNull();
    return result.tracking.application!;
  }

  async function stored(jobId: number) {
    const application = await getApplicationByJobId(getDb(), jobId);
    return { application, events: application ? await listApplicationEvents(getDb(), application.id) : [] };
  }

  async function databaseTime() {
    const [row] = await getDb().execute<{ ms: string }>(sql`select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as ms`);
    return Number(row!.ms);
  }

  it("uses midnight in the configured schedule zone on creation and reads it through both tracking tools", async () => {
    const id = await fixture(null);
    const client = await connect();
    await invoke(client, "mark_applied", { job_id: id, applied_at: "2026-11-12" });
    const expected = "2026-11-11T15:00:00.000Z";
    const application = await read(client, id);
    expect(application).toMatchObject({
      status: "applied", applied_at: expected, status_changed_at: expected,
      history: [{ from: null, to: "applied", occurred_at: expected, reference: null }],
    });
    expect((await stored(id)).application?.statusChangedAt).toEqual(new Date(expected));
    const job = getJobOutput.parse(await invoke(client, "get_job", { job_id: id }));
    expect(job.tracking?.application).toEqual(application);
  });

  it("records an earlier datetime while keeping the write event latest and supports undo", async () => {
    const id = await fixture("interested");
    const client = await connect();
    const initial = await read(client, id);
    expect(initial.applied_at).toBeNull();
    const before = await databaseTime();
    const receipt = trackingWriteOutput.parse(await invoke(client, "mark_applied", { job_id: id, ...recorded, reference: "  receipt-17  " }));
    const after = await databaseTime();
    const application = await read(client, id);
    expect(application).toMatchObject({ status: "applied", applied_at: occurredAt, status_changed_at: occurredAt });
    const [applied, interested] = application.history;
    expect(application.history).toHaveLength(2);
    expect(applied).toMatchObject({ from: "interested", to: "applied", occurred_at: occurredAt, reference: "receipt-17" });
    expect(interested).toEqual(initial.history[0]);
    expect(Date.parse(applied!.at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(applied!.at)).toBeLessThanOrEqual(after);
    const saved = await stored(id);
    expect(saved.application?.statusChangedAt).toEqual(new Date(occurredAt));
    expect(saved.events[0]).toMatchObject({ toStatus: "applied", at: new Date(applied!.at), occurredAt: new Date(occurredAt), reference: "receipt-17" });

    expect(receipt.undoable).toBe(true);
    expect(undoChangeOutput.parse(await invoke(client, "undo_change", { audit_id: receipt.audit_id })).field).toBe("application_status");
    expect(await read(client, id)).toMatchObject({
      status: "interested", history: [{ from: "applied", to: "interested", occurred_at: null, reference: null }, applied, interested],
    });
  });

  it.each([null, "interested"] as const)("uses the write time with omitted arguments from %s", async (from) => {
    const id = await fixture(from);
    const client = await connect();
    const receipt = trackingWriteOutput.parse(await invoke(client, "mark_applied", { job_id: id }));
    expect(receipt).toMatchObject({ job_id: id, field: "application_status", undoable: true });
    const { application, events: [event] } = await stored(id);
    expect(event).toMatchObject({ fromStatus: from, toStatus: "applied", occurredAt: null, reference: null });
    expect(application?.statusChangedAt).toEqual(event?.at);
    expect(await read(client, id)).toMatchObject({ applied_at: event?.at.toISOString(), status_changed_at: event?.at.toISOString() });
  });

  it("keeps the time and reference of an already applied job", async () => {
    const id = await fixture(null);
    const client = await connect();
    await invoke(client, "mark_applied", { job_id: id, ...recorded });
    const before = await stored(id);
    const receipt = trackingWriteOutput.parse(await invoke(client, "mark_applied", { job_id: id, applied_at: "2026-11-13", reference: "receipt-18" }));
    expect(receipt).toMatchObject({ undoable: false, research: null });
    expect(await stored(id)).toEqual(before);
  });

  it("web undo restores the previous clock and removes the event it takes back", async () => {
    const id = await fixture("interested");
    const client = await connect();
    const initial = await stored(id);
    await invoke(client, "mark_applied", { job_id: id, ...recorded });
    const applied = await stored(id);
    await setApplicationStatus(getDb(), id, "interviewing");
    expect(await undoApplicationStatusAction({ jobId: id, movedTo: "interviewing", restoreTo: "applied" })).toEqual({ ok: true, status: "applied" });
    expect(await stored(id)).toEqual(applied);
    expect(await undoApplicationStatusAction({ jobId: id, movedTo: "applied", restoreTo: "interested" })).toEqual({ ok: true, status: "interested" });
    expect(await stored(id)).toEqual(initial);
  });

  it.each(["interviewing", "offer", "rejected", "withdrawn"] as const)("refuses %s with the optional arguments", async (status) => {
    const id = await fixture(status);
    const client = await connect();
    const before = await stored(id);
    const result = await client.callTool({ name: "mark_applied", arguments: { job_id: id, ...recorded } });
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: text("errors.markAppliedNotAllowed") }] });
    expect(await stored(id)).toEqual(before);
  });

  it.each(["en", "zh"] as const)("rejects invalid input in %s before any tracking writes", async (locale) => {
    const id = await fixture("interested");
    const client = await connect(locale);
    const t = mcpTranslator(locale);
    const invalid = [
      ["applied_at", "2026-11-20", t("errors.appliedAtFuture")],
      ["applied_at", "2026-11-18T17:30:00.001+01:00", t("errors.appliedAtFuture")],
      ["applied_at", "2026-11-12T09:30:00", t("errors.appliedAtFormat")],
      ["reference", " \t ", t("errors.appliedReferenceLength", { max: 200 })],
      ["reference", "x".repeat(201), t("errors.appliedReferenceLength", { max: 200 })],
    ] as const;
    const before = await stored(id);
    const beforeJob = await snapshot(id);
    for (const [field, value, message] of invalid) {
      const result = await client.callTool({ name: "mark_applied", arguments: { job_id: id, [field]: value } });
      expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/^Input validation error:/) }] });
      expect(JSON.stringify(result.content)).toContain(`${field}: ${message}`);
      expect(await stored(id)).toEqual(before);
      expect(await snapshot(id)).toEqual(beforeJob);
    }
    expect(await getDb().select().from(schema.agentUndo)).toHaveLength(0);
    expect(await getDb().select().from(schema.agentBudgetUsage)).toHaveLength(0);
  });

  it("reads the newest applied transition even outside the returned history", async () => {
    const id = await fixture("offer");
    const { application } = await stored(id);
    const applicationId = application!.id;
    const start = Date.parse("2026-11-11T00:00:00Z");
    const past = "2026-11-06T00:00:00.000Z";
    await getDb().insert(schema.applicationEvents).values([
      { applicationId, fromStatus: null, toStatus: "applied", at: new Date(start), occurredAt: new Date("2026-11-10T00:00:00Z") },
      { applicationId, fromStatus: "interested", toStatus: "applied", at: new Date(start + 1), occurredAt: new Date(past) },
      ...Array.from({ length: 20 }, (_, index) => ({
        applicationId, toStatus: "interviewing" as const, at: new Date(start + index + 2),
      })),
    ]);
    const result = await read(await connect(), id);
    expect(result.applied_at).toBe(past);
    expect(result.history.some((event) => event.to === "applied")).toBe(false);
  });

  it("lists both optional parameters with descriptions only on mark_applied", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const mark = tools.find((tool) => tool.name === "mark_applied");
    expect(mark?.inputSchema).toMatchObject({
      required: ["job_id"],
      properties: {
        applied_at: { description: text("params.appliedAt") },
        reference: { description: text("params.appliedReference", { max: 200 }) },
      },
    });
    expect(Object.keys(tools.find((tool) => tool.name === "set_application_status")!.inputSchema.properties!)).toEqual(["job_id", "status"]);
  });
});

it("undo of a newly created application retains it as new and preserves append-only history", async () => {
  const id = await fixture(null);
  const receipt = await write("mark_applied", { job_id: id });
  await undo(receipt.audit_id);
  expect((await snapshot(id)).status).toBe("new");
  expect((await snapshot(id)).events).toEqual([{ from: "applied", to: "new", note: null }, { from: null, to: "applied", note: null }]);
});

it("serializes concurrent undo attempts so exactly one restores", async () => {
  const id = await fixture();
  const receipt = await write("set_interview_rounds", { job_id: id, rounds: 3 });
  const results = await Promise.all([call("undo_change", { audit_id: receipt.audit_id }), call("undo_change", { audit_id: receipt.audit_id })]);
  expect(results.filter((result) => "isError" in result)).toHaveLength(1);
  expect((await snapshot(id)).interviewRounds).toBe(0);
});

it("never exposes previous private text through generic undo, even with a notes-like test kind", async () => {
  const id = await fixture();
  const sentinel = "LOCAL-ONLY-PRIVATE-TEXT-SENTINEL";
  await setApplicationNotes(getDb(), id, sentinel);
  const kind: UndoKind = {
    area: "tracking", field: "test_private_field",
    async read(tx, target) { const app = await readApplicationForUndo(tx, target.id); return { value: app?.notesMd ?? null, fingerprint: valueFingerprint(app?.notesMd ?? null) }; },
    async restore(tx, target, value) { await setApplicationNotes(tx, target.id, String(value)); },
  };
  const registry = new Map([["test_private", kind]]);
  const access: AgentWriteAccess = { caller: "stdio", permissions: new Set(["tracking:write"]), audit, entry: () => ({ caller: "stdio", token_id: null, transport: "stdio", capability: "test_private", target: { type: "job", id }, outcome: "ok", error_category: null, returned_count: 1, duration_ms: 0 }) };
  const receipt = await writeWithUndo(getDb(), { access, registry, kind: "test_private", target: { type: "job", id } }, (tx) => setApplicationNotes(tx, id, "replacement"));
  const lookup = applicationUndoKinds.get.bind(applicationUndoKinds);
  const registered = vi.spyOn(applicationUndoKinds, "get").mockImplementation((key) => key === "test_private" ? kind : lookup(key));
  try {
    const result = await undo(receipt.auditId);
    expect(result.field).toBe("test_private_field");
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect((await getApplicationByJobId(getDb(), id))?.notesMd).toBe(sentinel);
  } finally { registered.mockRestore(); }
});

it("rolls back restoration and its once-only marker if the undo audit insert fails", async () => {
  const id = await fixture();
  const receipt = await write("set_interview_rounds", { job_id: id, rounds: 3 });
  await getDb().execute(sql`alter table agent_calls add constraint test_refuse_undo check (capability <> 'undo_change') not valid`);
  try {
    expect(await call("undo_change", { audit_id: receipt.audit_id })).toMatchObject({ isError: true });
    expect((await snapshot(id)).interviewRounds).toBe(3);
    expect(await getAgentCallUndoState(getDb(), receipt.audit_id)).toBe("undoable");
  } finally { await getDb().execute(sql`alter table agent_calls drop constraint test_refuse_undo`); }
  expect(await undo(receipt.audit_id)).toMatchObject({ field: "interview_rounds" });
});

it("detects status history that moved away and back even when the visible status matches", async () => {
  const id = await fixture();
  const receipt = await write("set_application_status", { job_id: id, status: "applied" });
  await setApplicationStatus(getDb(), id, "offer");
  await setApplicationStatus(getDb(), id, "applied");
  const before = await snapshot(id);
  expect(await call("undo_change", { audit_id: receipt.audit_id })).toMatchObject({ isError: true });
  expect(await snapshot(id)).toEqual(before);
});

it("serializes first application creation with the web without deadlocking or losing the before-value", async () => {
  const id = await fixture(null);
  const parentRead = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const base = applicationUndoKinds.get("application_status")!;
  let first = true;
  const kind: UndoKind = { ...base, async read(tx, target) {
    const snapshot = await base.read(tx, target);
    if (first) { first = false; parentRead.resolve(); await release.promise; }
    return snapshot;
  } };
  const registry = new Map([["application_status", kind]]);
  const access: AgentWriteAccess = { caller: "stdio", permissions: new Set(["tracking:write"]), audit, entry: () => ({ caller: "stdio", token_id: null, transport: "stdio", capability: "set_application_status", target: { type: "job", id }, outcome: "ok", error_category: null, returned_count: 1, duration_ms: 0 }) };
  const web = createConnection(url, { max: 1 });
  const [{ pid }] = await web.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
  const agentWrite = writeWithUndo(getDb(), { access, registry, kind: "application_status", target: { type: "job", id } }, (tx) => setApplicationStatus(tx, id, "applied"));
  await parentRead.promise;
  const webWrite = setApplicationStatus(web.db, id, "offer");
  const outcomes = Promise.allSettled([agentWrite, webWrite]);
  try {
    await expect.poll(async () => (await getDb().execute<{ waiting: string | null }>(sql`select wait_event_type as waiting from pg_stat_activity where pid = ${pid}`))[0]?.waiting).toBe("Lock");
    release.resolve();
    const results = await outcomes;
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await snapshot(id)).status).toBe("offer");
    const [saved] = await getDb().select().from(schema.agentUndo);
    expect(saved.beforeValue).toBe("new");
    expect(await call("undo_change", { audit_id: saved.auditId })).toMatchObject({ isError: true });
  } finally {
    release.resolve();
    await outcomes;
    await web.sql.end();
  }
});

it("reports budget unavailable without poisoning the write when a zero-cap usage read fails", async () => {
  cap = 0;
  const id = await fixture();
  await getDb().execute(sql`alter table agent_budget_usage rename to test_unavailable_budget_usage`);
  try {
    const receipt = await write("mark_applied", { job_id: id });
    expect(receipt.research).toBe("budget_skipped");
    expect(receipt.notices).toEqual([text("notice.researchBudgetSkipped")]);
    expect((await snapshot(id)).status).toBe("applied");
    expect((await snapshot(id)).queued).toEqual([]);
  } finally { await getDb().execute(sql`alter table test_unavailable_budget_usage rename to agent_budget_usage`); }
});

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { markAppliedAction, setApplicationStatusAction } from "@/app/jobs/[id]/actions";
import { saveNextActionAction, setInterviewRoundsAction } from "@/app/pipeline/actions";
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
import { getApplicationByJobId, listApplicationEvents, setApplicationNotes, setApplicationStatus } from "@/lib/db/repos/applications";
import { readApplicationForUndo } from "@/lib/db/repos/application-undo";
import { getOrCreateCompany } from "@/lib/db/repos/companies";
import { insertJob } from "@/lib/db/repos/jobs";
import { runLogged } from "@/lib/mcp/context";
import { trackingWriteOutput, undoChangeOutput } from "@/lib/mcp/dto";
import { defaultContext } from "@/lib/mcp/server";
import { mcpTranslator } from "@/lib/mcp/text";
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
beforeEach(() => { cap = 100; });
afterAll(async () => {
  await Promise.all(pending);
  await audit.close();
  await readOnly.close();
  await closeDb();
});

async function fixture(status: "new" | "interested" | "offer" | null = "new") {
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
  const ctx = defaultContext(readOnly.db, settings(), { trackingWriteDb: getDb(), readSettings: settings, text, log: () => undefined, audit, caller: { caller, tokenId: typeof caller === "number" ? caller : null, transport: caller === "stdio" ? "stdio" : "http" } });
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

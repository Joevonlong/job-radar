import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { agentCallConnections, listAgentCalls, summarizeAgentCalls, type AgentCallCursor, type AgentCallFilter } from "@/lib/db/repos/agent-calls";

const url = inject("testDatabaseUrl");
const db = () => getDb();
const T0 = Date.parse("2026-11-11T12:00:00Z");

let jobId: number;
let applicationId: number;
let questionId: number;
let tokenA: number;
let tokenB: number;

type CallInput = Partial<typeof schema.agentCalls.$inferInsert> & { at: number };
const call = ({ at, ...rest }: CallInput): typeof schema.agentCalls.$inferInsert => ({
  calledAt: new Date(T0 - at * 1000),
  caller: "stdio",
  transport: "stdio",
  capability: "get_job",
  outcome: "ok",
  returnedCount: 1,
  durationMs: 10,
  ...rest,
});

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});
afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await db().delete(schema.agentCalls);
  await db().delete(schema.agentTokens);
  await db().delete(schema.applicationQuestions);
  await db().delete(schema.applications);
  await db().delete(schema.jobs);
  await db().delete(schema.companies);
  const [company] = await db().insert(schema.companies).values({ name: "Example GmbH", nameNorm: "example" }).returning({ id: schema.companies.id });
  const [job] = await db()
    .insert(schema.jobs)
    .values({ companyId: company!.id, title: "Backend Engineer", titleNorm: "backend engineer" })
    .returning({ id: schema.jobs.id });
  jobId = job!.id;
  const [application] = await db().insert(schema.applications).values({ jobId }).returning({ id: schema.applications.id });
  applicationId = application!.id;
  const [question] = await db()
    .insert(schema.applicationQuestions)
    .values({ jobId, position: 1, text: "Why us?", kind: "question", lengthUnit: "words", lengthValue: 100, outputLanguage: "en", tone: "neutral" })
    .returning({ id: schema.applicationQuestions.id });
  questionId = question!.id;
  const tokens = await db()
    .insert(schema.agentTokens)
    .values([
      { name: "Laptop", tokenHash: "h1", tokenPrefix: "p1" },
      { name: "Old", tokenHash: "h2", tokenPrefix: "p2", revokedAt: new Date(T0) },
    ])
    .returning({ id: schema.agentTokens.id });
  tokenA = tokens[0]!.id;
  tokenB = tokens[1]!.id;
});

async function everyPage(filter: AgentCallFilter, limit: number): Promise<number[]> {
  const ids: number[] = [];
  let after: AgentCallCursor | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await listAgentCalls(db(), { filter, limit, after });
    ids.push(...page.rows.map((row) => row.id));
    const last = page.rows.at(-1);
    if (!page.hasMore || !last) return ids;
    after = { at: last.cursorAt, id: last.id };
  }
  throw new Error("pagination did not end");
}

describe("listAgentCalls", () => {
  it("filters by connection, tool, result and time, alone and together", async () => {
    await db().insert(schema.agentCalls).values([
      call({ at: 10, capability: "get_job", caller: `token:${tokenA}`, tokenId: tokenA, transport: "http" }),
      call({ at: 20, capability: "search_jobs", outcome: "not_permitted", returnedCount: 0 }),
      call({ at: 30, capability: "get_job", outcome: "error", errorCategory: "timeout", returnedCount: 0, caller: `token:${tokenB}`, tokenId: tokenB, transport: "http" }),
      call({ at: 4000, capability: "get_job" }),
    ]);
    const names = async (filter: AgentCallFilter) => (await listAgentCalls(db(), { filter, limit: 20 })).rows.map((row) => `${row.capability}/${row.outcome}/${row.caller}`);
    expect(await names({})).toHaveLength(4);
    expect(await names({ connection: "stdio" })).toHaveLength(2);
    expect(await names({ connection: tokenA })).toEqual([`get_job/ok/token:${tokenA}`]);
    expect(await names({ capability: "search_jobs" })).toEqual(["search_jobs/not_permitted/stdio"]);
    expect(await names({ outcome: "error" })).toEqual([`get_job/error/token:${tokenB}`]);
    expect(await names({ since: new Date(T0 - 60_000) })).toHaveLength(3);
    expect(await names({ connection: "stdio", capability: "get_job", since: new Date(T0 - 60_000) })).toEqual([]);
    expect(await names({ connection: tokenB, outcome: "error", since: new Date(T0 - 60_000) })).toEqual([`get_job/error/token:${tokenB}`]);
  });

  it("pages newest first without repeating or skipping rows, including rows with the same instant", async () => {
    const rows: CallInput[] = [];
    for (let n = 0; n < 23; n += 1) rows.push({ at: 100 + Math.floor(n / 5), durationMs: n });
    const inserted = await db().insert(schema.agentCalls).values(rows.map(call)).returning({ id: schema.agentCalls.id });
    const seen = await everyPage({}, 4);
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
    expect([...seen].sort((a, b) => a - b)).toEqual(inserted.map((row) => row.id).sort((a, b) => a - b));
    const whole = await listAgentCalls(db(), { filter: {}, limit: 100 });
    expect(seen).toEqual(whole.rows.map((row) => row.id));
    expect(whole.hasMore).toBe(false);
  });

  it("keeps microsecond order that a millisecond cursor would lose", async () => {
    await db().execute(`insert into agent_calls (called_at, caller, transport, capability, outcome, returned_count, duration_ms)
      select '2026-11-11 11:00:00.000100+00'::timestamptz + (g || ' microseconds')::interval, 'stdio', 'stdio', 'get_job', 'ok', 1, 1 from generate_series(0, 9) g` as never);
    const seen = await everyPage({}, 3);
    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
  });

  it("resolves a job, application or question target to the job title and company, and leaves a missing one null", async () => {
    await db().insert(schema.agentCalls).values([
      call({ at: 1, targetType: "job", targetId: jobId }),
      call({ at: 2, targetType: "application", targetId: applicationId }),
      call({ at: 3, targetType: "question", targetId: questionId }),
      call({ at: 4, targetType: "job", targetId: 987654 }),
      call({ at: 5 }),
    ]);
    const { rows } = await listAgentCalls(db(), { filter: {}, limit: 10 });
    expect(rows.slice(0, 3).map((row) => [row.jobId, row.jobTitle, row.company])).toEqual([
      [jobId, "Backend Engineer", "Example GmbH"],
      [jobId, "Backend Engineer", "Example GmbH"],
      [jobId, "Backend Engineer", "Example GmbH"],
    ]);
    expect(rows[3]).toMatchObject({ targetType: "job", targetId: 987654, jobId: null, jobTitle: null, company: null });
    expect(rows[4]).toMatchObject({ targetType: null, jobId: null });
  });

  it("names the token of a row, revoked or not", async () => {
    await db().insert(schema.agentCalls).values([call({ at: 1, tokenId: tokenB, caller: `token:${tokenB}` }), call({ at: 2 })]);
    const { rows } = await listAgentCalls(db(), { filter: {}, limit: 10 });
    expect(rows[0]).toMatchObject({ tokenName: "Old", tokenRevoked: true });
    expect(rows[1]).toMatchObject({ tokenName: null, tokenRevoked: false });
  });
});

describe("summarizeAgentCalls and agentCallConnections", () => {
  it("counts per result inside the filter", async () => {
    await db().insert(schema.agentCalls).values([call({ at: 1 }), call({ at: 2 }), call({ at: 3, outcome: "error", errorCategory: "timeout" }), call({ at: 5000, outcome: "invalid_input" })]);
    expect(await summarizeAgentCalls(db(), {})).toEqual({ ok: 2, error: 1, invalid_input: 1 });
    expect(await summarizeAgentCalls(db(), { since: new Date(T0 - 60_000) })).toEqual({ ok: 2, error: 1 });
  });

  it("lists every token, revoked ones included", async () => {
    expect(await agentCallConnections(db())).toEqual([
      { id: tokenB, name: "Old", revoked: true },
      { id: tokenA, name: "Laptop", revoked: false },
    ]);
  });
});

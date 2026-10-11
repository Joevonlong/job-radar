import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { BREAKDOWN_PROMPT_VERSION } from "@/lib/ai/prompts/breakdown";
import { createAiRouter, createDbUsageStore } from "@/lib/ai";
import type { BreakdownConfig } from "@/lib/config";
import { createBreakdownJobHandler } from "@/lib/control/breakdown-job";
import { readInitialTranslateRequest, requestTranslateJob } from "@/lib/control/translate-request";
import { readBreakdownRequest, readInitialBreakdownRequest, requestBreakdownJob } from "@/lib/control/breakdown-request";
import { aiWorkerRequestKinds, processNextControlRequest, registerControlHandler, resetControlHandlers, runnerRequestKinds } from "@/lib/control";
import { claimNextControlRequest, closeDb, getDb, schema } from "@/lib/db";
import { getJobBreakdown, listBreakdownCandidates } from "@/lib/db/repos/breakdowns";
import { runMigrations } from "@/lib/db/migrate";

import { pinnedAi, scriptedProvider } from "../ai/helpers";
import { quietLogger } from "../cycle/helpers";

const url = inject("testDatabaseUrl");
const NOW = new Date("2026-10-07T10:00:00Z");
const db = () => getDb();

const JD = "## Role\n\n- Build and operate retrieval pipelines in production.\n\nOur stack: Python and Kubernetes on AWS.";
const settings = (over: Partial<BreakdownConfig> = {}): BreakdownConfig => ({ enabled: true, mode: "manual", auto: { min_rank: 70, per_cycle_limit: 5 }, jd_max_chars: 12000, jd_head_share: 0.7, timeout_seconds: 240, ...over });
const okState = (over: Partial<BreakdownConfig> = {}) => ({ state: "ok" as const, config: settings(over) });

const reply = JSON.stringify({
  responsibilities: [{ text: "构建检索管线", quote: "Build and operate retrieval pipelines in production." }],
  tech_stack: [
    { name: "Python", category: "languages", requirement: "must", quote: "Our stack: Python and Kubernetes on AWS." },
    { name: "Made up", category: "tools", requirement: "nice", quote: "not in the JD at all" },
  ],
  experience: { years_min: null, years_quote: null, items: [] },
  projects: [],
  soft_skills: [],
  languages: [],
  other: [],
});

async function addJob(title: string, over: Partial<typeof schema.jobs.$inferInsert> = {}): Promise<number> {
  const [company] = await db().insert(schema.companies).values({ name: `Co ${title}`, nameNorm: `co ${title.toLowerCase()}` }).returning();
  const [job] = await db()
    .insert(schema.jobs)
    .values({ companyId: company!.id, title, titleNorm: title.toLowerCase(), description: JD, language: "en", ...over })
    .returning();
  return job!.id;
}
const addScore = (jobId: number, rankValue: number) => db().insert(schema.scores).values({ jobId, filterResult: "passed", score: Math.round(rankValue), rankValue, createdAt: new Date(NOW.getTime() - 3_600_000) });

function fakeRouter() {
  const { provider, transport } = scriptedProvider("codex-cli", [reply]);
  const tasks: string[] = [];
  const router = createAiRouter({ config: pinnedAi(), providers: [provider], usage: createDbUsageStore(db()), now: () => NOW });
  const wrapped = { ...router, run: ((task: Parameters<typeof router.run>[0], ...rest: unknown[]) => {
    tasks.push(task);
    return (router.run as (...args: unknown[]) => unknown)(task, ...rest);
  }) as typeof router.run };
  return { router: wrapped, tasks, calls: () => transport.calls.length };
}

const pollOptions = (kinds: () => ReturnType<typeof aiWorkerRequestKinds>) => ({ db: db(), signal: new AbortController().signal, logger: quietLogger, kinds });

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});
beforeEach(async () => {
  resetControlHandlers();
  await db().execute(sql`truncate table jobs, companies, control_requests, ai_usage restart identity cascade`);
});
afterAll(async () => {
  resetControlHandlers();
  await db().execute(sql`truncate table jobs, companies, control_requests, ai_usage restart identity cascade`);
  await closeDb();
});

describe("migration", () => {
  it("has the job_breakdowns table and the breakdown_job request kind", async () => {
    const tables = await db().execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' and table_name = 'job_breakdowns'`);
    expect(tables).toHaveLength(1);
    const kinds = await db().execute<{ enumlabel: string }>(sql`select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'control_request_kind'`);
    expect(kinds.map((k) => k.enumlabel)).toContain("breakdown_job");
  });
});

describe("the breakdown request chain (web -> ai-worker -> web)", () => {
  it("refuses when off or unreadable, queues once, shares an open request, and only the ai-worker claims it", async () => {
    const jobId = await addJob("Alpha");
    expect(await requestBreakdownJob(db(), { jobId, force: false, settings: okState({ enabled: false }) })).toEqual({ state: "error", error: "disabled" });
    expect(await requestBreakdownJob(db(), { jobId, force: false, settings: { state: "error", problem: "x" } })).toEqual({ state: "error", error: "config_error" });
    expect(await requestBreakdownJob(db(), { jobId: 9999, force: false, settings: okState() })).toEqual({ state: "error", error: "not_found" });
    const empty = await addJob("Empty", { description: "  " });
    expect(await requestBreakdownJob(db(), { jobId: empty, force: false, settings: okState() })).toEqual({ state: "error", error: "no_description" });
    expect(await db().select().from(schema.controlRequests)).toHaveLength(0);

    const queued = await requestBreakdownJob(db(), { jobId, force: false, settings: okState() });
    expect(queued).toMatchObject({ state: "queued", existing: false });
    if (queued.state !== "queued") throw new Error("expected queued");
    expect(await requestBreakdownJob(db(), { jobId, force: false, settings: okState() })).toMatchObject({ state: "queued", requestId: queued.requestId, existing: true });
    expect(await readBreakdownRequest(db(), { requestId: queued.requestId, jobId })).toEqual({ state: "waiting", stage: "pending" });
    expect(await readBreakdownRequest(db(), { requestId: queued.requestId, jobId: jobId + 1 })).toBeNull();

    expect(await claimNextControlRequest(db(), runnerRequestKinds("host"))).toBeNull();
    expect(aiWorkerRequestKinds("host")).toContain("breakdown_job");
  });

  it("the worker breaks the job down, keeps only verified items, and the page reads done; a second click is cached", async () => {
    const fake = fakeRouter();
    registerControlHandler("breakdown_job", createBreakdownJobHandler({ createRouter: () => fake.router, loadSettings: () => settings() }));
    const jobId = await addJob("Alpha");
    const queued = await requestBreakdownJob(db(), { jobId, force: false, settings: okState() });
    if (queued.state !== "queued") throw new Error("expected queued");

    const finished = await processNextControlRequest(pollOptions(() => aiWorkerRequestKinds("host")));
    expect(finished).toMatchObject({ status: "done", result: { jobId, cached: false, provider: "codex-cli", items: 2, dropped: 1 } });
    expect(await readBreakdownRequest(db(), { requestId: queued.requestId, jobId })).toEqual({ state: "done" });
    expect(fake.tasks).toEqual(["breakdown"]);

    const row = await getJobBreakdown(db(), jobId);
    expect(row).toMatchObject({ promptVersion: BREAKDOWN_PROMPT_VERSION, provider: "codex-cli", droppedItems: 1 });
    expect(row?.content).toMatchObject({ tech_stack: [{ name: "Python", offset: JD.indexOf("Our stack") }] });
    const usage = await db().select().from(schema.aiUsage);
    expect(usage.map((u) => u.task)).toEqual(["breakdown"]);

    expect(await requestBreakdownJob(db(), { jobId, force: false, settings: okState() })).toEqual({ state: "cached" });
    expect(await requestBreakdownJob(db(), { jobId, force: true, settings: okState() })).toMatchObject({ state: "queued", existing: false });
    // the JD changed: no longer current
    await db().update(schema.jobs).set({ description: `${JD}\nMore.` }).where(eq(schema.jobs.id, jobId));
    expect(await requestBreakdownJob(db(), { jobId, force: false, settings: okState() })).toMatchObject({ state: "queued" });
  });

  it("a failure is reported with its code", async () => {
    const { provider } = scriptedProvider("codex-cli", [new Error("x")]);
    const router = createAiRouter({ config: pinnedAi(), providers: [provider], usage: null, now: () => NOW });
    registerControlHandler("breakdown_job", createBreakdownJobHandler({ createRouter: () => router, loadSettings: () => settings({ enabled: true }) }));
    const jobId = await addJob("Alpha");
    const queued = await requestBreakdownJob(db(), { jobId, force: false, settings: okState() });
    if (queued.state !== "queued") throw new Error("expected queued");
    await processNextControlRequest(pollOptions(() => aiWorkerRequestKinds("host")));
    expect(await readBreakdownRequest(db(), { requestId: queued.requestId, jobId })).toMatchObject({ state: "failed" });
  });
});

describe("the card's state after a reload", () => {
  it("an open request resumes the waiting state, a failed one the failure, a finished one nothing", async () => {
    const jobId = await addJob("Reload");
    expect(await readInitialBreakdownRequest(db(), jobId, null)).toBeNull();
    const queued = await requestBreakdownJob(db(), { jobId, force: false, settings: okState() });
    if (queued.state !== "queued") throw new Error("expected a queued request");
    expect(await readInitialBreakdownRequest(db(), jobId, null)).toEqual({ state: "waiting", requestId: queued.requestId, stage: "pending" });
    await db().update(schema.controlRequests).set({ status: "running" }).where(eq(schema.controlRequests.id, queued.requestId));
    expect(await readInitialBreakdownRequest(db(), jobId, null)).toMatchObject({ state: "waiting", stage: "running" });
    // another job's open request never leaks over
    const other = await addJob("Other");
    expect(await readInitialBreakdownRequest(db(), other, null)).toBeNull();
    const finishedAt = new Date("2026-10-07T10:05:00Z");
    await db().update(schema.controlRequests).set({ status: "failed", finishedAt, result: { error: "timeout", detail: "codex-cli: timeout" } }).where(eq(schema.controlRequests.id, queued.requestId));
    expect(await readInitialBreakdownRequest(db(), jobId, null)).toEqual({ state: "failed", error: "timeout", detail: "codex-cli: timeout" });
    // a result made after the failure hides it
    expect(await readInitialBreakdownRequest(db(), jobId, new Date("2026-10-07T10:09:00Z"))).toBeNull();
    await db().update(schema.controlRequests).set({ status: "done", result: {} }).where(eq(schema.controlRequests.id, queued.requestId));
    expect(await readInitialBreakdownRequest(db(), jobId, null)).toBeNull();
  });
});

describe("the translate tab's state after a reload", () => {
  it("an open translate request resumes the waiting state; none or a finished one does not", async () => {
    const jobId = await addJob("Reload translate");
    expect(await readInitialTranslateRequest(db(), jobId)).toBeNull();
    const queued = await requestTranslateJob(db(), { jobId, force: false });
    if (queued.state !== "queued") throw new Error("expected a queued request");
    expect(await readInitialTranslateRequest(db(), jobId)).toEqual({ requestId: queued.requestId, stage: "pending" });
    await db().update(schema.controlRequests).set({ status: "running" }).where(eq(schema.controlRequests.id, queued.requestId));
    expect(await readInitialTranslateRequest(db(), jobId)).toEqual({ requestId: queued.requestId, stage: "running" });
    await db().update(schema.controlRequests).set({ status: "done" }).where(eq(schema.controlRequests.id, queued.requestId));
    expect(await readInitialTranslateRequest(db(), jobId)).toBeNull();
  });
});

describe("automatic candidates", () => {
  it("picks open, scored, described jobs at the threshold without a current breakdown; a changed JD returns, an old prompt does not", async () => {
    const top = await addJob("Top");
    await addScore(top, 92);
    const edge = await addJob("Edge");
    await addScore(edge, 70);
    const low = await addJob("Low");
    await addScore(low, 69);
    const closed = await addJob("Closed", { status: "closed" });
    await addScore(closed, 99);
    const noText = await addJob("NoText", { description: null });
    await addScore(noText, 88);
    const unscored = await addJob("Unscored");
    void unscored;

    const hash = (text: string) => db().execute<{ h: string }>(sql`select encode(sha256(convert_to(${text}, 'UTF8')), 'hex') as h`).then((r) => r[0]!.h);
    const done = await addJob("Done");
    await addScore(done, 85);
    await db().insert(schema.jobBreakdowns).values({ jobId: done, sourceHash: await hash(JD), promptVersion: BREAKDOWN_PROMPT_VERSION, content: {}, outputLang: "zh" });
    const changed = await addJob("Changed");
    await addScore(changed, 80);
    await db().insert(schema.jobBreakdowns).values({ jobId: changed, sourceHash: "older-description", promptVersion: BREAKDOWN_PROMPT_VERSION, content: {}, outputLang: "zh" });
    const oldPrompt = await addJob("OldPrompt");
    await addScore(oldPrompt, 75);
    await db().insert(schema.jobBreakdowns).values({ jobId: oldPrompt, sourceHash: await hash(JD), promptVersion: "breakdown-v0", content: {}, outputLang: "zh" });

    const found = await listBreakdownCandidates(db(), { minRank: 70, limit: 10 });
    expect(found.map((c) => c.jobId)).toEqual([top, changed, edge]);
    expect((await listBreakdownCandidates(db(), { minRank: 70, limit: 2 })).map((c) => c.jobId)).toEqual([top, changed]);
    expect((await listBreakdownCandidates(db(), { minRank: 80, limit: 10 })).map((c) => c.jobId)).toEqual([top, changed]);
  });
});

import { eq, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { BREAKDOWN_PROMPT_VERSION } from "@/lib/ai/prompts/breakdown";
import { createDbHealthStore } from "@/lib/ai/health";
import type { AiRouter } from "@/lib/ai/router";
import { researchSchema, salarySchema, type BreakdownConfig, type ResearchConfig, type SalaryConfig } from "@/lib/config";
import { createBreakdownJobHandler } from "@/lib/control/breakdown-job";
import { requestBreakdownJob } from "@/lib/control/breakdown-request";
import { createSalaryLookupHandler } from "@/lib/control/salary-lookup";
import { requestSalaryLookup } from "@/lib/control/salary-request";
import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { getOrCreateCompany } from "@/lib/db/repos/companies";
import { controlLaneOf } from "@/lib/db/repos/control-requests";
import { insertJob } from "@/lib/db/repos/jobs";
import { countSalaryLookupRequests } from "@/lib/db/repos/salary-lookups";
import { listHighScoreResearchCandidates, reserveAutoResearchRun } from "@/lib/db/repos/research-auto-runs";
import { requestAutoResearch, type AutoResearchDeps } from "@/lib/research/auto";
import { getResearchBarStatus } from "@/lib/research/bar";
import { canMoveUp, researchAllItems } from "@/lib/research/bar-view";
import { runResearchSubtask } from "@/lib/research/subtask";
import { descriptionHash } from "@/lib/translation/hash";

import { pinnedAi } from "../ai/helpers";
import { quietLogger } from "../cycle/helpers";

const url = inject("testDatabaseUrl");
const NOW = new Date("2026-11-02T10:00:00Z");
const db = () => getDb();

/** Built here: the tests never depend on the shipped files. */
function research(auto: Record<string, unknown> = {}, enabled = true): ResearchConfig {
  return researchSchema.parse({
    enabled,
    company: { ttl_days: 30, max_per_day: 3, max_searches: 8, timeout_seconds: 60, max_field_chars: 400, allowed_domains: ["linkedin.com"], non_company_hosts: ["linkedin.com"], employees: { min: 1, max: 3_000_000 }, rating: { min: 0, max: 5 }, web_search_usd: 0.01 },
    auto: {
      trigger: "favorite_or_applying",
      items: ["company", "breakdown", "salary"],
      max_per_day: 10,
      high_score: { enabled: true, min_rank: 80, per_cycle_limit: 2, max_age_days: 3, max_per_day: 5 },
      ...auto,
    },
  });
}

function salary(maxPerDay = 3, enabled = true): SalaryConfig {
  return salarySchema.parse({
    benchmark: { enabled: true, window_days: 365, min_sample: 3 },
    role_families: [{ id: "ml_engineer", label: { en: "ML engineer" }, patterns: ["\\bml engineer\\b"] }],
    deep_links: [],
    lookup: { enabled, ttl_days: 30, max_per_day: maxPerDay, timeout_seconds: 60, max_searches: 4, allowed_fetch_domains: ["levels.fyi"], sanity_annual: { min: 5000, max: 2000000 }, unconvertible_max_annual: 100_000_000_000 },
  });
}

const breakdown = (enabled = true): BreakdownConfig => ({ enabled, mode: "manual", auto: { min_rank: 70, per_cycle_limit: 5 }, jd_max_chars: 12000, jd_head_share: 0.7, timeout_seconds: 240 });

const webAi = () =>
  pinnedAi((raw) => {
    (raw.tasks as Record<string, unknown>).company_research = { order: ["anthropic"] };
    (raw.tasks as Record<string, unknown>).salary_lookup = { order: ["anthropic"] };
  });

function deps(over: { research?: ResearchConfig; salary?: SalaryConfig; breakdown?: BreakdownConfig; ai?: ReturnType<typeof pinnedAi>; webOpen?: AutoResearchDeps["webOpen"] } = {}): AutoResearchDeps {
  return {
    research: () => over.research ?? research(),
    ai: () => over.ai ?? webAi(),
    salary: () => ({ state: "ok", config: over.salary ?? salary() }),
    breakdown: () => ({ state: "ok", config: over.breakdown ?? breakdown() }),
    timeZone: () => "UTC",
    process: "web",
    ...(over.webOpen ? { webOpen: over.webOpen } : {}),
  };
}

let serial = 0;
async function addJob(over: { description?: string; firstSeenAt?: Date } = {}): Promise<number> {
  serial += 1;
  const company = await getOrCreateCompany(db(), { name: `Co ${serial}`, nameNorm: `co ${serial}` });
  const job = await insertJob(db(), {
    companyId: company.id,
    title: `ML Engineer ${serial}`,
    titleNorm: `ml engineer ${serial}`,
    seniority: "senior",
    description: over.description ?? "Build models.",
    locationsJson: [{ label: "Berlin, DE", city: "Berlin", countryCode: "DE", isPrimary: true }],
    firstSeenAt: over.firstSeenAt ?? NOW,
  });
  return job.id;
}

const requests = async () => (await db().select().from(schema.controlRequests)).map((row) => ({ kind: row.kind, payload: row.payload as Record<string, unknown>, lane: controlLaneOf(row.kind, row.payload) }));
const runCount = async () => (await db().select().from(schema.researchAutoRuns)).length;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});
beforeEach(async () => {
  await db().execute(sql`truncate table jobs, companies, ai_usage, company_research, salary_lookups, control_requests, research_auto_runs, activity_spans, activity_events restart identity cascade`);
  await db().delete(schema.runtimeState).where(like(schema.runtimeState.key, "ai_%"));
});
afterAll(async () => {
  await closeDb();
});

describe("a saved job", () => {
  it("queues every part in the batch lane, and counts one run", async () => {
    const jobId = await addJob();
    const result = await requestAutoResearch(db(), { jobId, event: "favorite", now: NOW }, deps());
    expect(result).toMatchObject({ outcome: "queued", items: { company: "queued", breakdown: "queued", salary: "queued" } });
    const queued = await requests();
    expect(queued.map((row) => row.kind).sort()).toEqual(["breakdown_job", "company_research", "salary_lookup"]);
    for (const row of queued) {
      expect(row.payload.origin).toBe("auto");
      expect(row.lane).toBe("batch");
    }
    expect(await runCount()).toBe(1);
  });

  it("does nothing while research is off or the trigger does not cover it", async () => {
    const jobId = await addJob();
    expect((await requestAutoResearch(db(), { jobId, event: "favorite", now: NOW }, deps({ research: research({}, false) }))).outcome).toBe("off");
    expect((await requestAutoResearch(db(), { jobId, event: "favorite", now: NOW }, deps({ research: research({ trigger: "manual" }) }))).outcome).toBe("off");
    expect((await requestAutoResearch(db(), { jobId, event: "status", now: NOW }, deps({ research: research({ trigger: "favorite" }) }))).outcome).toBe("off");
    expect(await requests()).toEqual([]);
    expect(await runCount()).toBe(0);
  });

  it("only counts a job once per 24 hours, whatever the trigger", async () => {
    const jobId = await addJob();
    await requestAutoResearch(db(), { jobId, event: "favorite", now: NOW }, deps());
    const second = await requestAutoResearch(db(), { jobId, event: "status", now: new Date(NOW.getTime() + 3_600_000) }, deps());
    expect(second.outcome).toBe("recent");
    expect(await runCount()).toBe(1);
    const dayLater = await requestAutoResearch(db(), { jobId, event: "status", now: new Date(NOW.getTime() + 25 * 3_600_000) }, deps());
    expect(dayLater.outcome).not.toBe("recent");
  });

  it("does not count when everything is cached", async () => {
    const description = "Build models.";
    const jobId = await addJob({ description });
    await db().insert(schema.jobBreakdowns).values({ jobId, sourceHash: descriptionHash(description), promptVersion: BREAKDOWN_PROMPT_VERSION, content: {}, outputLang: "en", provider: "anthropic", model: "m", analyzedAt: NOW });
    const result = await requestAutoResearch(db(), { jobId, event: "favorite", now: NOW }, deps({ research: research({ items: ["breakdown"] }) }));
    expect(result).toMatchObject({ outcome: "all_cached", items: { breakdown: "cached" } });
    expect(await runCount()).toBe(0);
  });

  it("leaves out a part that is switched off", async () => {
    const jobId = await addJob();
    const result = await requestAutoResearch(db(), { jobId, event: "favorite", now: NOW }, deps({ breakdown: breakdown(false), salary: salary(3, false) }));
    expect(result.items).toMatchObject({ company: "queued", breakdown: "disabled", salary: "disabled" });
    expect((await requests()).map((row) => row.kind)).toEqual(["company_research"]);
  });

  it("while the web tasks cannot run, queues only what needs no web, and nothing when nothing else is left", async () => {
    const jobId = await addJob();
    const closed = await requestAutoResearch(db(), { jobId, event: "favorite", now: NOW }, deps({ webOpen: async () => false }));
    expect(closed.items).toMatchObject({ company: "deferred_quota", breakdown: "queued", salary: "deferred_quota" });
    expect((await requests()).map((row) => row.kind)).toEqual(["breakdown_job"]);

    const webOnly = await addJob();
    const none = await requestAutoResearch(db(), { jobId: webOnly, event: "favorite", now: NOW }, deps({ research: research({ items: ["company", "salary"] }), webOpen: async () => false }));
    expect(none.outcome).toBe("deferred_quota");
    expect(await runCount()).toBe(1);
  });

  it("reads a provider's cooldown without being able to start it, and writes no state", async () => {
    const jobId = await addJob();
    await createDbHealthStore(db()).noteFailure("anthropic", NOW, { kind: "rate_limited", message: "slow down", coolingUntil: new Date(NOW.getTime() + 3_600_000) });
    const before = await db().select({ key: schema.runtimeState.key }).from(schema.runtimeState);
    const result = await requestAutoResearch(db(), { jobId, event: "favorite", now: NOW }, deps({ research: research({ items: ["company"] }) }));
    expect(result.outcome).toBe("deferred_quota");
    expect(await db().select({ key: schema.runtimeState.key }).from(schema.runtimeState)).toEqual(before);
    expect(await requests()).toEqual([]);
  });
});

describe("the limits", () => {
  it("an automatic salary lookup leaves the manual quota alone", async () => {
    const auto = await addJob();
    await requestAutoResearch(db(), { jobId: auto, event: "favorite", now: NOW }, deps({ research: research({ items: ["salary"] }), salary: salary(1) }));
    expect(await countSalaryLookupRequests(db(), NOW)).toBe(0);
    const manual = await addJob();
    const outcome = await requestSalaryLookup(db(), { jobId: manual, force: false, salary: salary(1), ai: webAi(), now: NOW });
    expect(outcome.state).toBe("queued");
  });

  it("a manual lookup joining a waiting automatic one moves it up and counts it", async () => {
    const jobId = await addJob();
    await requestAutoResearch(db(), { jobId, event: "favorite", now: NOW }, deps({ research: research({ items: ["salary"] }) }));
    const outcome = await requestSalaryLookup(db(), { jobId, force: false, salary: salary(), ai: webAi(), now: NOW });
    expect(outcome).toMatchObject({ state: "queued", existing: true });
    const [row] = await requests();
    expect(row?.lane).toBe("interactive");
    expect(await countSalaryLookupRequests(db(), NOW)).toBe(1);
  });

  it("a manual breakdown joining a waiting automatic one moves it up", async () => {
    const jobId = await addJob();
    await requestAutoResearch(db(), { jobId, event: "favorite", now: NOW }, deps({ research: research({ items: ["breakdown"] }) }));
    await requestBreakdownJob(db(), { jobId, force: false, settings: { state: "ok", config: breakdown() } });
    const [row] = await requests();
    expect(row?.lane).toBe("interactive");
  });

  it("twenty at once cannot pass the limit", async () => {
    const jobs = await Promise.all(Array.from({ length: 20 }, () => addJob()));
    const results = await Promise.all(jobs.map((jobId) => reserveAutoResearchRun(db(), { jobId, trigger: "favorite", items: {}, maxPerDay: 5, now: NOW })));
    expect(results.filter((r) => r.state === "reserved")).toHaveLength(5);
    expect(results.filter((r) => r.state === "cap_reached")).toHaveLength(15);
  });

  it("the same job twice at once counts once", async () => {
    const jobId = await addJob();
    const results = await Promise.all([1, 2, 3].map(() => reserveAutoResearchRun(db(), { jobId, trigger: "favorite", items: {}, maxPerDay: 5, now: NOW })));
    expect(results.filter((r) => r.state === "reserved")).toHaveLength(1);
  });

  it("high-score jobs have a limit of their own", async () => {
    const saved = await addJob();
    await reserveAutoResearchRun(db(), { jobId: saved, trigger: "favorite", items: {}, maxPerDay: 1, now: NOW });
    const other = await addJob();
    expect((await reserveAutoResearchRun(db(), { jobId: other, trigger: "status", items: {}, maxPerDay: 1, now: NOW })).state).toBe("cap_reached");
    expect((await reserveAutoResearchRun(db(), { jobId: other, trigger: "high_score_new", items: {}, maxPerDay: 1, now: NOW })).state).toBe("reserved");
    const third = await addJob();
    expect((await reserveAutoResearchRun(db(), { jobId: third, trigger: "high_score_new", items: {}, maxPerDay: 1, now: NOW })).state).toBe("cap_reached");
  });

  it("records what it stopped for, in the activity log, under the web process", async () => {
    const first = await addJob();
    await requestAutoResearch(db(), { jobId: first, event: "favorite", now: NOW }, deps({ research: research({ max_per_day: 1 }) }));
    const second = await addJob();
    const capped = await requestAutoResearch(db(), { jobId: second, event: "favorite", now: NOW }, deps({ research: research({ max_per_day: 1 }) }));
    expect(capped.outcome).toBe("cap_reached");
    const spans = await db().select().from(schema.activitySpans).where(eq(schema.activitySpans.name, "system.research_auto"));
    expect(spans.map((span) => [span.process, span.status, span.reasonCode, span.jobId])).toEqual(
      expect.arrayContaining([["web", "ok", null, first], ["web", "skipped", "research_cap_reached", second]]),
    );
  });
});

describe("the worker", () => {
  const context = { db: db as never, signal: new AbortController().signal, logger: quietLogger };

  it("stops an automatic request once research is off, and runs a manual one regardless", async () => {
    const off = () => research({}, false);
    const breakdownHandler = createBreakdownJobHandler({ createRouter: () => { throw new Error("must not be reached"); }, loadSettings: () => breakdown(), loadResearch: off });
    const stopped = await breakdownHandler({ id: 1, kind: "breakdown_job", payload: { jobId: 1, force: false, origin: "auto" } } as never, { ...context, db: db() } as never);
    expect(stopped).toEqual({ status: "failed", result: { jobId: 1, error: "research_disabled" } });
    const salaryHandler = createSalaryLookupHandler({ createRouter: () => { throw new Error("must not be reached"); }, loadSettings: () => salary(), loadResearch: off, loadMoney: () => ({ currency: "EUR", fx: {} as never }) });
    const stoppedSalary = await salaryHandler({ id: 2, kind: "salary_lookup", payload: { jobId: 1, force: false, origin: "auto" } } as never, { ...context, db: db() } as never);
    expect(stoppedSalary).toEqual({ status: "failed", result: { jobId: 1, error: "research_disabled" } });
    const manual = await breakdownHandler({ id: 3, kind: "breakdown_job", payload: { jobId: 999, force: false } } as never, { ...context, db: db() } as never);
    // past the switch: it fails later, for its own reason
    expect(manual.result?.error).not.toBe("research_disabled");
  });
});

describe("high-score new jobs", () => {
  async function scored(rank: number, firstSeenAt = NOW): Promise<number> {
    const jobId = await addJob({ firstSeenAt });
    await db().insert(schema.scores).values({ jobId, filterResult: "passed", score: rank, rankValue: rank });
    return jobId;
  }

  it("takes the best open new jobs that have no run and no star", async () => {
    const best = await scored(95);
    const good = await scored(85);
    await scored(70);
    await scored(90, new Date(NOW.getTime() - 5 * 86_400_000));
    const starred = await scored(99);
    await db().insert(schema.jobFavorites).values({ jobId: starred });
    const ran = await scored(98);
    await reserveAutoResearchRun(db(), { jobId: ran, trigger: "favorite", items: {}, maxPerDay: 5, now: NOW });
    expect(await listHighScoreResearchCandidates(db(), { minRank: 80, maxAgeDays: 3, limit: 10, now: NOW, isExcludedCompany: () => false })).toEqual([best, good]);
  });

  const ctx = (dryRun = false) => ({ cycle: { db: db(), dryRun, signal: new AbortController().signal, logger: quietLogger }, router: { usable: async () => ({ usable: true, blocked: [] }) } as unknown as AiRouter }) as never;

  const subtaskDeps = (settings: ResearchConfig) => ({
    loadResearch: () => settings,
    listCandidates: listHighScoreResearchCandidates,
    request: requestAutoResearch,
    deps: () => deps({ research: settings }),
    excludedCompany: () => () => false,
  });

  it("spends nothing on a job the user is done with or on a company the user excluded", async () => {
    const open = await scored(90);
    const archived = await scored(99);
    await db().insert(schema.applications).values({ jobId: archived, status: "archived" });
    const rejected = await scored(98);
    await db().insert(schema.applications).values({ jobId: rejected, status: "rejected" });
    const closedByUser = await scored(97);
    await db().insert(schema.jobClosureOverrides).values({ jobId: closedByUser, action: "closed" });
    const excluded = await scored(96);
    const [row] = await db().select({ company: schema.jobs.companyId }).from(schema.jobs).where(eq(schema.jobs.id, excluded));
    const [company] = await db().select({ name: schema.companies.name }).from(schema.companies).where(eq(schema.companies.id, row!.company));
    const candidates = await listHighScoreResearchCandidates(db(), { minRank: 80, maxAgeDays: 3, limit: 1, now: NOW, isExcludedCompany: (c) => c.name === company!.name });
    expect(candidates).toEqual([open]);
  });

  it("records a deferral once per cycle, however many jobs it held back", async () => {
    for (const rank of [95, 94, 93]) await scored(rank, new Date());
    const held = { ...subtaskDeps(research({ items: ["company"] })), deps: () => deps({ research: research({ items: ["company"] }), webOpen: async () => false }) };
    expect(await runResearchSubtask(ctx(), held)).toMatchObject({ candidates: 3, queued: 0 });
    expect(await db().select().from(schema.activitySpans).where(eq(schema.activitySpans.name, "system.research_auto"))).toHaveLength(1);
  });

  it("records the deferral of a run that queued the other parts", async () => {
    const jobId = await addJob();
    const result = await requestAutoResearch(db(), { jobId, event: "favorite", now: NOW }, deps({ webOpen: async () => false }));
    expect(result.outcome).toBe("queued");
    const spans = await db().select().from(schema.activitySpans).where(eq(schema.activitySpans.name, "system.research_auto"));
    expect(spans.map((span) => span.status).sort()).toEqual(["ok", "skipped"]);
  });

  it("queues at most the per-cycle limit", async () => {
    for (const rank of [95, 94, 93]) await scored(rank, new Date());
    const result = await runResearchSubtask(ctx(), subtaskDeps(research({ items: ["company"] })));
    expect(result).toMatchObject({ candidates: 3, queued: 2 });
    expect(await runCount()).toBe(2);
  });

  it("stays out of the way when off or dry", async () => {
    expect((await runResearchSubtask(ctx(), subtaskDeps(research({}, false)))).skipped).toBe("disabled");
    expect((await runResearchSubtask(ctx(), subtaskDeps(research({ high_score: { enabled: false, min_rank: 80, per_cycle_limit: 2, max_age_days: 3, max_per_day: 5 } })))).skipped).toBe("off");
    expect((await runResearchSubtask(ctx(true), subtaskDeps(research()))).skipped).toBe("dry run");
  });
});

describe("the bar", () => {
  const status = (jobId: number, settings: ResearchConfig, over: { salary?: SalaryConfig; breakdown?: BreakdownConfig } = {}) =>
    getResearchBarStatus(db(), { jobId, research: settings, ai: webAi(), salary: { state: "ok", config: over.salary ?? salary() }, breakdown: { state: "ok", config: over.breakdown ?? breakdown() }, now: NOW });

  it("is absent when research is off and nothing is stored", async () => {
    const jobId = await addJob();
    expect(await status(jobId, research({}, false))).toBeNull();
  });

  it("says what is missing, what runs and what is switched off", async () => {
    const jobId = await addJob();
    expect(await status(jobId, research(), { breakdown: breakdown(false) })).toMatchObject({
      canRequest: true,
      items: { company: { state: "missing" }, breakdown: { state: "off", settingsTab: "breakdown" }, salary: { state: "missing" } },
    });
    await requestAutoResearch(db(), { jobId, event: "favorite", now: NOW }, deps());
    expect((await status(jobId, research()))?.items).toMatchObject({ company: { state: "running" }, breakdown: { state: "running" }, salary: { state: "running" } });
  });

  it("lets a press move up an automatic request that is still waiting, and no other", async () => {
    const jobId = await addJob();
    await requestAutoResearch(db(), { jobId, event: "favorite", now: NOW }, deps({ research: research({ items: ["breakdown"] }) }));
    const waiting = await status(jobId, research());
    expect(waiting?.items.breakdown).toEqual({ state: "running", stage: "pending", auto: true });
    expect(canMoveUp(waiting?.items.breakdown)).toBe(true);
    expect(researchAllItems(waiting)).toContain("breakdown");

    await requestBreakdownJob(db(), { jobId, force: false, settings: { state: "ok", config: breakdown() } });
    const [request] = await db().select().from(schema.controlRequests).where(eq(schema.controlRequests.kind, "breakdown_job"));
    expect(controlLaneOf(request!.kind, request!.payload)).toBe("interactive");
    const movedUp = await status(jobId, research());
    expect(movedUp?.items.breakdown).toEqual({ state: "running", stage: "pending", auto: false });
    expect(canMoveUp(movedUp?.items.breakdown)).toBe(false);
    expect(researchAllItems(movedUp)).not.toContain("breakdown");
  });

  it("says off rather than showing a result that cannot be refreshed, unless research itself is off", async () => {
    const jobId = await addJob();
    await db().insert(schema.jobBreakdowns).values({ jobId, sourceHash: descriptionHash("Build models."), promptVersion: BREAKDOWN_PROMPT_VERSION, content: {}, outputLang: "en", provider: "anthropic", model: "m", analyzedAt: NOW });
    const off = { breakdown: breakdown(false) };
    expect((await status(jobId, research(), off))?.items.breakdown).toEqual({ state: "off", settingsTab: "breakdown" });
    expect((await status(jobId, research({}, false), off))?.items.breakdown).toMatchObject({ state: "done" });
  });

  it("keeps listing a stored result when research is off and a newer request failed", async () => {
    const jobId = await addJob();
    await db().insert(schema.jobBreakdowns).values({ jobId, sourceHash: descriptionHash("Build models."), promptVersion: BREAKDOWN_PROMPT_VERSION, content: {}, outputLang: "en", provider: "anthropic", model: "m", analyzedAt: new Date(NOW.getTime() - 3_600_000) });
    await requestAutoResearch(db(), { jobId, event: "favorite", now: NOW }, deps({ research: research({ items: ["breakdown"] }) }));
    await db().update(schema.controlRequests).set({ status: "failed", finishedAt: NOW, result: { jobId, error: "provider_error" } });
    expect((await status(jobId, research()))?.items.breakdown).toMatchObject({ state: "failed" });
    expect((await status(jobId, research({}, false)))?.items.breakdown).toMatchObject({ state: "done" });
  });

  it("does not treat a request stopped by the switch as a failure", async () => {
    const jobId = await addJob();
    await requestAutoResearch(db(), { jobId, event: "favorite", now: NOW }, deps({ research: research({ items: ["breakdown"] }) }));
    await db().update(schema.controlRequests).set({ status: "failed", finishedAt: NOW, result: { jobId, error: "research_disabled" } });
    expect((await status(jobId, research()))?.items.breakdown).toEqual({ state: "missing" });
  });
});


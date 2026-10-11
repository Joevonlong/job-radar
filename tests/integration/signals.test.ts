import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { createProvider } from "@/lib/ai/provider";
import { createAiRouter } from "@/lib/ai/router";
import { createAiStep, registerAiSubtask, resetAiSubtasks } from "@/lib/ai/step";
import type { AiTransport, AiTransportRequest } from "@/lib/ai/types";
import type { InterestsConfig } from "@/lib/config";
import type { CycleStepContext } from "@/lib/cycle/steps";
import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { getSignalScan, listJobsToReview, listSignalsOfJob, saveAiReview } from "@/lib/db/repos/signals";
import { highValuePolicy, reconcileBonuses, revalueSignals, runAiReview, runRuleScan, signalsAiSubtask, signalsStep } from "@/lib/signals";
import { getJobDetail, listJobs, listTodayJobs } from "@/lib/db";

import { config as cycleConfig, quietLogger } from "../cycle/helpers";
import { pinnedAi } from "../ai/helpers";
import { rawAmount, rawCategory, shippedInterests, shippedPipeline } from "../signals/helpers";

const url = inject("testDatabaseUrl");
const pipeline = shippedPipeline();

const JD_RICH = [
  "## What we offer",
  "Salary: €85,000–105,000 per year plus equity.",
  "Competitive salary package for the right person.",
  "Bonus points if you know Rust.",
  "We also pay a yearly performance bonus of up to 10%.",
  "- 30 Tage Urlaub",
].join("\n");
const JD_PLAIN = "Build things with a great team in Berlin. No money talk here.";
const JD_DEI = "We value diversity, equity and inclusion. Join our team.";

/** An AI that answers from a script keyed on the JD it is shown; records every call. */
function fakeAi(answer: (request: AiTransportRequest) => unknown) {
  const calls: AiTransportRequest[] = [];
  const transport: AiTransport = {
    id: "claude-cli",
    availability: () => ({ available: true }),
    async call(request) {
      calls.push(request);
      return { text: JSON.stringify(answer(request)), model: "fake-model", usage: { tokensIn: 100, tokensOut: 20 } };
    },
  };
  const router = createAiRouter({ config: pinnedAi(), providers: [createProvider(transport)], usage: null });
  return { router, calls };
}

const idOfCandidate = (request: AiTransportRequest, tier: string, contains: string): number => {
  const line = request.user.split("\n").find((l) => l.startsWith("[") && l.includes(` ${tier}`) && l.includes(contains));
  const id = line ? Number(/^\[(\d+)\]/.exec(line)?.[1]) : NaN;
  if (Number.isNaN(id)) throw new Error(`candidate ${tier} "${contains}" not in the prompt`);
  return id;
};

/** What a sensible model says about JD_RICH: confirm T1, T3 and the real bonus; reject nothing. */
const richAnswer = (request: AiTransportRequest) => ({
  signals: [
    { tier: "T1", kind: "salary_range", quote: "x", candidate: idOfCandidate(request, "T1", "85,000"), amount: { min: 85000, max: 105000, currency: "EUR", period: "year" } },
    { tier: "T2", kind: "equity", quote: "x", candidate: idOfCandidate(request, "T2", "equity"), amount: null },
    { tier: "T4", kind: "performance_bonus", quote: "x", candidate: idOfCandidate(request, "T4", "performance bonus"), amount: null },
    // invented: not in the JD, must be discarded
    { tier: "T2", kind: "equity", quote: "Generous ESOP with four year vesting", candidate: null, amount: null },
  ],
  rejected: [],
});

/**
 * A job as the pipeline and the hard filter leave it: the job plus its `scores` row (what the filter step
 * creates; it has no match score yet). `scoreRow: false` leaves the job without one.
 */
async function newJob(title: string, description: string | null, opts: { status?: "active" | "closed"; companyName?: string; scoreRow?: boolean } = {}): Promise<number> {
  const db = getDb();
  const [company] = await db
    .insert(schema.companies)
    .values({ name: opts.companyName ?? `Co ${title}`, nameNorm: `co ${title}`.toLowerCase() })
    .returning({ id: schema.companies.id });
  const [job] = await db
    .insert(schema.jobs)
    .values({ companyId: company!.id, title, titleNorm: title.toLowerCase(), description, status: opts.status ?? "active" })
    .returning({ id: schema.jobs.id });
  if (opts.scoreRow !== false) await db.insert(schema.scores).values({ jobId: job!.id, filterResult: "passed" });
  return job!.id;
}

/** The AI scorer's part: a match score (and rank value without bonus) in the job's row. */
const giveScore = (jobId: number, score: number) => getDb().update(schema.scores).set({ score, rankValue: score }).where(eq(schema.scores.jobId, jobId));

const resetTables = () => getDb().execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels, applications restart identity cascade`);

const scanOptions = (interests: InterestsConfig = shippedInterests()) => ({ interests, pipeline, logger: quietLogger, batchSize: 50 });
const tiersOf = async (jobId: number) => (await listSignalsOfJob(getDb(), jobId)).map((s) => `${s.tier}:${s.extractor}`);

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});
beforeEach(resetTables);
afterEach(() => resetAiSubtasks());
afterAll(async () => {
  await resetTables();
  await closeDb();
});

describe("rule scan", () => {
  it("stores rule signals with quotes, leaves the T4 candidate to the AI, writes the scan state", async () => {
    const rich = await newJob("Rich", JD_RICH);
    const plain = await newJob("Plain", JD_PLAIN);
    const dei = await newJob("DEI", JD_DEI);
    await newJob("No JD", null);

    const result = await runRuleScan(getDb(), scanOptions());
    expect(result).toMatchObject({ scanned: 3, withSignals: 1, failed: 0, aborted: false });

    const rows = await listSignalsOfJob(getDb(), rich);
    expect(rows.map((r) => r.tier)).toEqual(["T1", "T2", "T3", "tag"]);
    expect(rows.every((r) => r.extractor === "rule")).toBe(true);
    for (const row of rows) {
      expect(JD_RICH.slice(row.quoteOffset ?? 0, (row.quoteOffset ?? 0) + row.quote.length)).toBe(row.quote); // C7
    }
    expect(rows[0]).toMatchObject({ kind: "salary_range", value: { currency: "EUR", min: 85000, max: 105000, eurPerYear: { min: 85000, max: 105000 } } });
    expect(await listSignalsOfJob(getDb(), plain)).toEqual([]);
    expect(await listSignalsOfJob(getDb(), dei)).toEqual([]); // "diversity, equity and inclusion" is not equity

    const scan = await getSignalScan(getDb(), rich);
    expect(scan).toMatchObject({ candidateCount: 4, aiDescriptionHash: null });
    expect((await getSignalScan(getDb(), plain))?.candidateCount).toBe(0);
  });

  it("is idempotent, and rescans when the JD or the vocabulary changes", async () => {
    const job = await newJob("Rich", JD_RICH);
    expect((await runRuleScan(getDb(), scanOptions())).scanned).toBe(1);
    expect((await runRuleScan(getDb(), scanOptions())).scanned).toBe(0);

    await getDb().update(schema.jobs).set({ description: `${JD_RICH}\nAnd a sabbatical.` }).where(eq(schema.jobs.id, job));
    expect((await runRuleScan(getDb(), scanOptions())).scanned).toBe(1);
    expect((await listSignalsOfJob(getDb(), job)).some((s) => s.kind === "sabbatical")).toBe(true);

    const edited = shippedInterests((raw) => {
      rawCategory(raw, "T3").patterns = [];
      rawCategory(raw, "T3").keywords = ["competitive salary"];
    });
    expect((await runRuleScan(getDb(), scanOptions(edited))).scanned).toBe(1);
  });
});

describe("score bonus", () => {
  it("writes the capped bonus into scores, and the rank value once a score exists", async () => {
    const interests = shippedInterests();
    const rich = await newJob("Rich", JD_RICH);
    const scored = await newJob("Scored", "Equity for everyone, competitive salary package.");
    await giveScore(scored, 70);
    await runRuleScan(getDb(), scanOptions(interests));

    const result = await reconcileBonuses(getDb(), interests);
    expect(result).toMatchObject({ updated: 2 });

    const richScore = (await getDb().select().from(schema.scores).where(eq(schema.scores.jobId, rich)))[0];
    // T1 10 + T2 8 + T3 3 = 21, capped at 15; no match score yet, so no rank value
    expect(richScore).toMatchObject({ signalBonus: 15, rankValue: null, score: null, filterResult: "passed" });
    const scoredRow = (await getDb().select().from(schema.scores).where(eq(schema.scores.jobId, scored)))[0];
    expect(scoredRow).toMatchObject({ signalBonus: 11, rankValue: 81, score: 70 }); // T2 8 + T3 3
    expect((await reconcileBonuses(getDb(), interests)).updated).toBe(0);
  });

  it("follows edited weights and cap without any AI", async () => {
    const interests = shippedInterests();
    const job = await newJob("Scored", "Equity for everyone, competitive salary package.");
    await giveScore(job, 60);
    await runRuleScan(getDb(), scanOptions(interests));
    await reconcileBonuses(getDb(), interests);

    const heavier = shippedInterests((raw) => {
      rawCategory(raw, "T2").weight = 12;
      raw.bonus_cap = 10;
    });
    expect((await reconcileBonuses(getDb(), heavier)).updated).toBe(1);
    expect((await getDb().select().from(schema.scores).where(eq(schema.scores.jobId, job)))[0]).toMatchObject({ signalBonus: 10, rankValue: 70 });
  });

  it("drops the bonus again when the signals disappear", async () => {
    const interests = shippedInterests();
    const job = await newJob("Scored", "Equity for everyone.");
    await giveScore(job, 60);
    await runRuleScan(getDb(), scanOptions(interests));
    await reconcileBonuses(getDb(), interests);
    await getDb().delete(schema.signals).where(eq(schema.signals.jobId, job));
    await reconcileBonuses(getDb(), interests);
    expect((await getDb().select().from(schema.scores).where(eq(schema.scores.jobId, job)))[0]).toMatchObject({ signalBonus: 0, rankValue: 60 });
  });
});

describe("score rows of the hard filter and the scorer", () => {
  it("never creates a score row; a job gets its bonus once the filter step made one", async () => {
    const interests = shippedInterests();
    const job = await newJob("NoRow", JD_RICH, { scoreRow: false });
    await runRuleScan(getDb(), scanOptions(interests));
    expect(await reconcileBonuses(getDb(), interests)).toMatchObject({ checked: 0, updated: 0 });
    expect(await getDb().select().from(schema.scores).where(eq(schema.scores.jobId, job))).toEqual([]);
    await getDb().insert(schema.scores).values({ jobId: job, filterResult: "passed" });
    expect(await reconcileBonuses(getDb(), interests)).toMatchObject({ updated: 1 });
  });

  it("updates every snapshot row of a job, with the rank formula, and respects the (job, snapshot) unique index", async () => {
    const interests = shippedInterests();
    const job = await newJob("TwoSnapshots", "Equity for everyone, competitive salary package.", { scoreRow: false });
    const [a, b] = await getDb()
      .insert(schema.profileSnapshots)
      .values([
        { kind: "preferences", contentYaml: "a: 1", hash: "hash-a" },
        { kind: "preferences", contentYaml: "b: 1", hash: "hash-b" },
      ])
      .returning({ id: schema.profileSnapshots.id });
    await getDb().insert(schema.scores).values([
      { jobId: job, profileSnapshotId: a!.id, filterResult: "passed", score: 50, rankValue: 50, stale: true },
      { jobId: job, profileSnapshotId: b!.id, filterResult: "passed", score: 70, rankValue: 70 },
    ]);
    await runRuleScan(getDb(), scanOptions(interests));
    expect(await reconcileBonuses(getDb(), interests)).toMatchObject({ checked: 2, updated: 2 });
    const rows = await getDb().select().from(schema.scores).where(eq(schema.scores.jobId, job)).orderBy(schema.scores.id);
    expect(rows.map((r) => [r.signalBonus, r.rankValue])).toEqual([[11, 61], [11, 81]]);
    expect(await getDb().select().from(schema.scores).where(eq(schema.scores.jobId, job))).toHaveLength(2); // no extra row
  });
});

describe("T1 below the salary floor", () => {
  const Sprachwerk = "Job Type: Freelance\nRate: 15 USD/Hour\nHelp Shape the Future of AI";
  const WELL_PAID = "Salary: €85,000–105,000 per year plus equity.";

  // "15 USD/Hour" is another region's pay too; here only the floor is under test
  const floorOnly = () => shippedInterests((raw) => {
    rawAmount(raw).other_region_weight = 10;
  });

  it("keeps the amount, but gives no T1 bonus; follows the floor without any AI", async () => {
    const interests = floorOnly();
    const sprachwerk = await newJob("Sprachwerk", Sprachwerk);
    const paid = await newJob("Paid", WELL_PAID);
    await giveScore(sprachwerk, 60);
    await giveScore(paid, 60);
    await runRuleScan(getDb(), scanOptions(interests));
    expect(await tiersOf(sprachwerk)).toEqual(["T1:rule"]); // still extracted and shown

    await reconcileBonuses(getDb(), interests, 70000);
    const bonusOf = async (id: number) => (await getDb().select().from(schema.scores).where(eq(schema.scores.jobId, id)))[0];
    expect(await bonusOf(sprachwerk)).toMatchObject({ signalBonus: 0, rankValue: 60 });
    expect(await bonusOf(paid)).toMatchObject({ signalBonus: 15, rankValue: 75 }); // T1 10 + T2 8, capped

    // the user lowers the floor: the $15/hour job (28k EUR) now counts
    await reconcileBonuses(getDb(), interests, 20000);
    expect(await bonusOf(sprachwerk)).toMatchObject({ signalBonus: 10, rankValue: 70 });
    await reconcileBonuses(getDb(), interests, 70000);
    expect(await bonusOf(sprachwerk)).toMatchObject({ signalBonus: 0, rankValue: 60 });
  });

  it("is left out of the T1/T2 filter", async () => {
    const interests = floorOnly();
    const sprachwerk = await newJob("Sprachwerk", Sprachwerk);
    const paid = await newJob("Paid", WELL_PAID);
    await runRuleScan(getDb(), scanOptions(interests));
    const policy = highValuePolicy(interests, 70000, "EUR");
    expect((await reconcileBonuses(getDb(), interests, 70000)).updated).toBe(1); // only "Paid" has a bonus to write

    const base = { sort: "rank" as const, page: 1, pageSize: 50, timezone: "Europe/Berlin" };
    const strict = await listJobs(getDb(), { ...base, filters: { highValue: policy } });
    expect(strict.jobs.map((j) => j.id)).toEqual([paid]);
    const loose = await listJobs(getDb(), { ...base, filters: { highValue: highValuePolicy(interests, null) } });
    expect(loose.jobs.map((j) => j.id).sort()).toEqual([sprachwerk, paid].sort());
    const today = await listTodayJobs(getDb(), { now: new Date(), timezone: "Europe/Berlin", highValueOnly: true, highValue: policy });
    expect(today.map((j) => j.id)).toEqual([paid]);
    const none = await listJobs(getDb(), { ...base, filters: { highValue: highValuePolicy(shippedInterests((raw) => { rawAmount(raw).bonus_requires_at_least = "none"; rawAmount(raw).other_region_weight = 10; }), 70000, "EUR") } });
    expect(none.total).toBe(2);
  });

  it("an amount of another region brings no T1 bonus and is left out of the T1/T2 filter with the shipped weight", async () => {
    const interests = shippedInterests();
    const usd = await newJob("USD", "Compensation: $160,000 - $200,000 per year.");
    const paid = await newJob("Paid", "Salary: €85,000–105,000 per year.");
    await giveScore(usd, 60);
    await runRuleScan(getDb(), scanOptions(interests));
    await reconcileBonuses(getDb(), interests, 70000);
    const [row] = await getDb().select().from(schema.scores).where(eq(schema.scores.jobId, usd));
    expect(row).toMatchObject({ signalBonus: 0, rankValue: 60 });
    const strict = await listJobs(getDb(), { sort: "rank", page: 1, pageSize: 50, timezone: "Europe/Berlin", filters: { highValue: highValuePolicy(interests, 70000, "EUR") } });
    expect(strict.jobs.map((j) => j.id)).toEqual([paid]);
  });
});

describe("stored amounts follow the rates without a rescan", () => {
  it("revalues T1 amounts in place once per change of the valuation settings, keeping the AI review", async () => {
    const id = await newJob("USD", "Compensation: $160,000 - $200,000 per year.");
    await runRuleScan(getDb(), scanOptions());
    await getDb().update(schema.signalScans).set({ aiDescriptionHash: sql`description_hash`, aiPromptVersion: "v-test" }).where(eq(schema.signalScans.jobId, id));
    // a value stored before rates existed
    const [signal] = await getDb().select().from(schema.signals).where(eq(schema.signals.jobId, id));
    const { otherRegion: _mark, ...stored } = signal?.valueJson as Record<string, unknown>;
    void _mark;
    const old = { ...stored, eurPerYear: null };
    await getDb().update(schema.signals).set({ valueJson: old }).where(eq(schema.signals.id, signal!.id));

    expect(await revalueSignals(getDb(), { interests: shippedInterests(), pipeline, batchSize: 50 })).toEqual({ checked: 1, updated: 1 });
    const [after] = await getDb().select().from(schema.signals).where(eq(schema.signals.jobId, id));
    expect(after?.valueJson).toMatchObject({ currency: "USD", eurPerYear: { min: 137600, max: 172000 }, otherRegion: "currency" });
    expect(after?.id).toBe(signal!.id);
    expect(await getSignalScan(getDb(), id)).toMatchObject({ aiPromptVersion: "v-test" });
    // same settings: nothing to do; the rule scan has nothing to redo either
    expect(await revalueSignals(getDb(), { interests: shippedInterests(), pipeline, batchSize: 50 })).toBeNull();
    expect((await runRuleScan(getDb(), scanOptions())).scanned).toBe(0);
  });
});

describe("AI review with a fake provider", () => {
  async function setup() {
    const interests = shippedInterests();
    const rich = await newJob("Rich", JD_RICH);
    const plain = await newJob("Plain", JD_PLAIN);
    const filtered = await newJob("Filtered", "Stock options and a competitive salary.");
    const closed = await newJob("Closed", "Stock options and a competitive salary.", { status: "closed" });
    await getDb().update(schema.scores).set({ filterResult: "filtered_out", filterReasons: ["student"] }).where(eq(schema.scores.jobId, filtered));
    await runRuleScan(getDb(), scanOptions(interests));
    return { interests, rich, plain, filtered, closed };
  }

  it("confirms candidates, adds the real bonus, discards an invented quote, and skips filtered and closed jobs", async () => {
    const { interests, rich, plain, filtered, closed } = await setup();
    const ai = fakeAi((request) => (request.user.includes("performance bonus") ? richAnswer(request) : { signals: [], rejected: [] }));
    const result = await runAiReview(getDb(), { router: ai.router, interests, pipeline, logger: quietLogger, limit: 80 });

    expect(result).toMatchObject({ reviewed: 2, failed: 0, skipped: 0, stopped: null, providers: { "claude-cli": 2 } });
    expect(ai.calls).toHaveLength(2); // rich + plain only
    expect(result.stats).toMatchObject({ confirmed: 3, droppedQuote: 1, added: 0 });

    const signals = await listSignalsOfJob(getDb(), rich);
    expect(signals.map((s) => `${s.tier}:${s.kind}:${s.extractor}`)).toEqual([
      "T1:salary_range:rule",
      "T2:equity:rule",
      "T3:competitive_pay:rule", // not mentioned by the AI: stays as the rules found it
      "T4:performance_bonus:ai", // needed the AI's confirmation
      "tag:28+ vacation days:rule",
    ]);
    expect(signals.find((s) => s.tier === "T4")?.quote).toBe("We also pay a yearly performance bonus of up to 10%.");
    expect(signals.some((s) => s.quote.includes("vesting"))).toBe(false); // invented quote discarded
    expect(await listSignalsOfJob(getDb(), plain)).toEqual([]);

    const review = await getSignalScan(getDb(), rich);
    expect(review).toMatchObject({ aiProvider: "claude-cli", aiModel: "fake-model", aiPromptVersion: expect.stringMatching(/^signals-v/) });
    expect(review?.aiDescriptionHash).toBe(review?.descriptionHash);
    expect(await listSignalsOfJob(getDb(), filtered)).toHaveLength(2); // rule signals only, never sent to the AI
    expect((await getSignalScan(getDb(), closed))?.aiScannedAt).toBeNull();
  });

  it("does not ask again for a reviewed job; a changed JD or prompt version asks again", async () => {
    const { interests, rich } = await setup();
    const ai = fakeAi(() => ({ signals: [], rejected: [] }));
    const run = () => runAiReview(getDb(), { router: ai.router, interests, pipeline, logger: quietLogger, limit: 80 });
    expect((await run()).reviewed).toBe(2);
    expect((await run()).reviewed).toBe(0);

    await getDb().update(schema.jobs).set({ description: `${JD_RICH}\nPlus a signing bonus.` }).where(eq(schema.jobs.id, rich));
    expect(await listJobsToReview(getDb(), { promptVersion: "signals-v1", limit: 10, withoutCandidates: true })).toHaveLength(0); // rule scan first
    await runRuleScan(getDb(), scanOptions(interests));
    expect((await run()).reviewed).toBe(1);

    expect(await listJobsToReview(getDb(), { promptVersion: "signals-v999", limit: 10, withoutCandidates: true })).toHaveLength(2);
  });

  it("sends jobs with candidates first, honours the limit and skips candidate-less jobs when configured", async () => {
    const { interests } = await setup();
    const ai = fakeAi(() => ({ signals: [], rejected: [] }));
    const first = await runAiReview(getDb(), { router: ai.router, interests, pipeline, logger: quietLogger, limit: 1 });
    expect(first.reviewed).toBe(1);
    expect(ai.calls[0]?.user).toContain("Salary: €85,000"); // the rich one, not the plain one

    const strict = shippedInterests((raw) => {
      (raw.limits as Record<string, unknown>).ai_review_without_candidates = false;
    });
    const second = await runAiReview(getDb(), { router: ai.router, interests: strict, pipeline, logger: quietLogger, limit: 80 });
    expect(second.reviewed).toBe(0); // plain has no candidates
  });

  it("lets the AI reject a rule candidate, which removes the signal and the bonus", async () => {
    const { interests, rich } = await setup();
    const ai = fakeAi((request) => ({ signals: [], rejected: [idOfCandidate(request, "T3", "Competitive salary"), idOfCandidate(request, "T2", "equity")] }));
    await runAiReview(getDb(), { router: ai.router, interests, pipeline, logger: quietLogger, limit: 80, jobIds: [rich] });
    expect((await tiersOf(rich)).sort()).toEqual(["T1:rule", "tag:rule"]);
    await reconcileBonuses(getDb(), interests);
    expect((await getDb().select().from(schema.scores).where(eq(schema.scores.jobId, rich)))[0]?.signalBonus).toBe(10);
  });

  it("normalizes amounts the rules could not read (monthly salary) and ignores amounts that are not in the quote", async () => {
    const interests = shippedInterests();
    const job = await newJob("Monthly", "Your team: great people.\nMonthly gross salary for this role: EUR 7,200.");
    await runRuleScan(getDb(), scanOptions(interests));
    expect(await listSignalsOfJob(getDb(), job)).toEqual([]);
    const quote = "Monthly gross salary for this role: EUR 7,200.";
    const ai = fakeAi(() => ({
      signals: [
        { tier: "T1", kind: "salary", quote, candidate: null, amount: { min: 7200, max: 7200, currency: "EUR", period: "month" } },
        { tier: "T1", kind: "salary", quote, candidate: null, amount: { min: 1, max: 1, currency: "EUR", period: "year" } },
      ],
      rejected: [],
    }));
    const result = await runAiReview(getDb(), { router: ai.router, interests, pipeline, logger: quietLogger, limit: 80 });
    expect(result.stats.added).toBe(1);
    const rows = await listSignalsOfJob(getDb(), job);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tier: "T1", kind: "salary_fixed", extractor: "ai", value: { min: 86400, max: 86400, stated: { min: 7200, period: "month" } } });
  });

  it("stops after repeated failures and keeps the rule signals", async () => {
    const { interests, rich } = await setup();
    const broken: AiTransport = { id: "claude-cli", availability: () => ({ available: true }), call: async () => ({ text: "not json", model: "m", usage: { tokensIn: 1, tokensOut: 1 } }) };
    const router = createAiRouter({ config: pinnedAi(), providers: [createProvider(broken)], usage: null });
    const result = await runAiReview(getDb(), { router, interests, pipeline, logger: quietLogger, limit: 80 });
    expect(result).toMatchObject({ reviewed: 0, failed: 2, stopped: null });
    expect((await tiersOf(rich)).sort()).toEqual(["T1:rule", "T2:rule", "T3:rule", "tag:rule"]);
    expect((await getSignalScan(getDb(), rich))?.aiScannedAt).toBeNull(); // asked again next cycle
  });

  it("drops the review when the JD changed while the AI was working", async () => {
    const { rich } = await setup();
    const scan = await getSignalScan(getDb(), rich);
    await getDb().update(schema.jobs).set({ description: "Something else entirely." }).where(eq(schema.jobs.id, rich));
    const stored = await saveAiReview(getDb(), {
      jobId: rich,
      descriptionHash: scan?.descriptionHash ?? "",
      promptVersion: "signals-v1",
      provider: "claude-cli",
      model: "m",
      activeIds: ["T1", "T2", "T3", "T4", "tag"],
      signals: [{ tier: "T2", kind: "equity", value: null, quote: "x", quoteOffset: 0, extractor: "ai" }],
    });
    expect(stored).toBe(false);
    expect((await listSignalsOfJob(getDb(), rich)).some((s) => s.quote === "x")).toBe(false);
  });
});

describe("cycle wiring", () => {
  function ctx(): CycleStepContext {
    return { cycle: { id: null, kind: "manual" }, windowKind: null, dryRun: false, db: getDb(), signal: new AbortController().signal, logger: quietLogger, now: () => new Date(), config: cycleConfig(), channels: undefined as never, results: {} };
  }

  it("runs the rule step, then the AI sub-task inside the ai step, and the bonus follows", async () => {
    const rich = await newJob("Rich", JD_RICH);
    const stepResult = await signalsStep(ctx());
    expect(stepResult).toMatchObject({ status: "ok", result: { scan: { scanned: 1, signals: 4 }, bonus: { updated: 1 } } });

    const ai = fakeAi(richAnswer);
    registerAiSubtask({ name: "signals", run: signalsAiSubtask });
    const step = createAiStep({ loadAiConfig: () => pinnedAi(), createRouter: () => ai.router });
    const outcome = await step(ctx());
    expect(outcome).toMatchObject({ status: "ok", result: { subtasks: [{ name: "signals", status: "ok", result: { reviewed: 1, stats: { confirmed: 3 } } }] } });
    expect((await tiersOf(rich)).sort()).toEqual(["T1:rule", "T2:rule", "T3:rule", "T4:ai", "tag:rule"]);
  });

  it("shows up in the dashboard queries: badges data on the list, the detail, and the T1/T2 filter", async () => {
    const rich = await newJob("Rich", JD_RICH);
    const plain = await newJob("Plain", JD_PLAIN);
    const onlyT3 = await newJob("OnlyT3", "A competitive salary package.");
    await signalsStep(ctx());

    const detail = await getJobDetail(getDb(), rich);
    expect(detail?.signals.map((s) => s.tier)).toEqual(["T1", "T2", "T3", "tag"]);
    expect(detail?.signalScan).toMatchObject({ ruleScanned: true, aiReviewed: false });
    expect(detail?.score).toMatchObject({ signalBonus: 15 });

    const base = { filters: {}, sort: "rank" as const, page: 1, pageSize: 50, timezone: "Europe/Berlin" };
    const all = await listJobs(getDb(), base);
    expect(all.total).toBe(3);
    const policy = highValuePolicy(shippedInterests(), null);
    const high = await listJobs(getDb(), { ...base, filters: { highValue: policy } });
    expect(high.jobs.map((j) => j.id)).toEqual([rich]);
    expect(high.total).toBe(1);

    const today = await listTodayJobs(getDb(), { now: new Date(), timezone: "Europe/Berlin", includeFiltered: false, highValueOnly: true, highValue: policy });
    expect(today.map((j) => j.id)).toEqual([rich]);
    void plain;
    void onlyT3;
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { stringify } from "yaml";

import { AiProviderError } from "@/lib/ai/errors";
import { SCORE_PROMPT_VERSION } from "@/lib/ai/prompts/score";
import { createProvider } from "@/lib/ai/provider";
import { createAiRouter } from "@/lib/ai/router";
import { createAiStep, registerAiSubtask, resetAiSubtasks } from "@/lib/ai/step";
import type { AiTransport, AiTransportRequest } from "@/lib/ai/types";
import { resetConfigCache } from "@/lib/config";
import type { CycleStepContext } from "@/lib/cycle/steps";
import { closeDb, countStaleScores, getDb, getJobDetail, listJobs, listTodayJobs, listProfileSnapshots, markScoresStaleExcept, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { countScoreBacklog, listScoreCandidates } from "@/lib/db/repos/scores";
import { recordProfileSnapshot } from "@/lib/profile/snapshots";
import { currentPreferencesSnapshotId, recheckGerman, registerScoringSubtask, rescoreStale, runScoring, scoreBacklog, scoreJobs, SCORE_SUBTASK_NAME, type ScoringDeps, type ScoringProfile } from "@/lib/scoring";

import { config as cycleConfig, quietLogger } from "../cycle/helpers";
import { shippedPipeline } from "../pipeline/helpers";
import { aiConfig, answer, examplePreferences, exampleMe } from "../scoring/helpers";

const url = inject("testDatabaseUrl");
const NOW = new Date("2026-10-07T10:00:00Z");
const HOUR = 3_600_000;

/** What the fake provider answers for a posting, found by its title in the prompt. */
type Reply = string | Error;
interface Fake {
  calls: string[];
  router: ScoringDeps["router"];
  replies: Map<string, Reply>;
}

function fakeAi(config = aiConfig()): Fake {
  const calls: string[] = [];
  const replies = new Map<string, Reply>();
  const transport: AiTransport = {
    id: "claude-cli",
    availability: () => ({ available: true }),
    async call(request: AiTransportRequest) {
      const title = /^Title: (.*)$/m.exec(request.user)?.[1] ?? "?";
      calls.push(title);
      const reply = replies.get(title) ?? answer();
      if (reply instanceof Error) throw reply;
      return { text: reply, model: "fake-model", usage: { tokensIn: 100, tokensOut: 20 } };
    },
  };
  const router = createAiRouter({ config, providers: [createProvider(transport)], usage: null });
  return { calls, router, replies };
}

const profile = (me = exampleMe()): ScoringProfile => ({ me, preferences: examplePreferences(), meYaml: stringify(me), preferencesYaml: stringify(examplePreferences()) });

function deps(fake: Fake, over: Partial<ScoringDeps> = {}): ScoringDeps {
  return { db: getDb(), router: fake.router, config: aiConfig(), logger: quietLogger, now: () => NOW, loadProfile: async () => profile(), loadBonusCap: () => 15, ...over };
}

interface JobSpec {
  title: string;
  /** Hours before NOW the job was first seen. */
  age?: number;
  german?: string;
  status?: "active" | "possibly_closed" | "closed";
  description?: string | null;
  /** `passed` (default): the hard filter's row for the current snapshot exists, as it does when a cycle reaches the `ai` step. `none`: no row. */
  filter?: "passed" | "none";
}

let companyCounter = 0;
async function addJob(spec: JobSpec): Promise<number> {
  const db = getDb();
  companyCounter += 1;
  const [company] = await db.insert(schema.companies).values({ name: `Company ${companyCounter}`, nameNorm: `company ${companyCounter}` }).returning();
  const [job] = await db
    .insert(schema.jobs)
    .values({
      companyId: company!.id,
      title: spec.title,
      titleNorm: spec.title.toLowerCase(),
      description: spec.description === undefined ? `Description of ${spec.title}` : spec.description,
      germanLevelRequired: spec.german ?? "unknown",
      status: spec.status ?? "active",
      firstSeenAt: new Date(NOW.getTime() - (spec.age ?? 1) * HOUR),
    })
    .returning();
  if ((spec.filter ?? "passed") === "passed") {
    await getDb().insert(schema.scores).values({ jobId: job!.id, profileSnapshotId: await currentSnapshot(), filterResult: "passed" });
  }
  return job!.id;
}

const scoreRows = (jobId: number) => getDb().select().from(schema.scores).where(eq(schema.scores.jobId, jobId)).orderBy(desc(schema.scores.id));
async function latest(jobId: number) {
  const [row] = await scoreRows(jobId);
  if (!row) throw new Error(`job ${jobId} has no score row`);
  return row;
}

const resetTables = () =>
  getDb().execute(sql`truncate table jobs, companies, scores, profile_snapshots, ai_usage, applications restart identity cascade`);

/** The snapshot id scores are filed under for `profile()`; makes the snapshots when they are not there yet. */
const currentSnapshot = () => currentPreferencesSnapshotId(getDb(), profile());

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

beforeEach(async () => {
  await resetTables();
});

afterAll(async () => {
  await resetTables();
  await closeDb();
});

describe("migration 0005", () => {
  it("adds the scoring columns to scores", async () => {
    const rows = await getDb().execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'scores'
        and column_name in ('ai_score', 'german_penalty', 'german_level', 'german_level_ai', 'german_level_source', 'prompt_version', 'scored_at')
      order by column_name`);
    expect(rows.map((r) => r.column_name)).toEqual(["ai_score", "german_level", "german_level_ai", "german_level_source", "german_penalty", "prompt_version", "scored_at"]);
  });
});

describe("migration 0027", () => {
  it("backfills the summaries and the language of the AI texts from the old columns", async () => {
    const jobId = await addJob({ title: "Old score" });
    const unscored = await addJob({ title: "Filter only" });
    const [old] = await getDb().insert(schema.scores).values({ jobId, filterResult: "passed", score: 70, aiScore: 70, rankValue: 70, fitReasons: ["理由"], summaryZh: " 旧摘要 ", summaryEn: "" }).returning({ id: schema.scores.id });
    const [bare] = await getDb().insert(schema.scores).values({ jobId: unscored, filterResult: "passed" }).returning({ id: schema.scores.id });
    // the migration's backfill statement, run again on rows that look like they were written before it
    const file = fs.readFileSync(path.resolve(import.meta.dirname, "../../drizzle/0027_language_texts.sql"), "utf8");
    const backfill = file.split("--> statement-breakpoint").find((statement) => statement.includes('UPDATE "scores"'));
    expect(backfill).toBeDefined();
    await getDb().execute(sql.raw(backfill ?? ""));
    const rows = await getDb().select({ id: schema.scores.id, summaries: schema.scores.summaries, outputLang: schema.scores.outputLang, summaryZh: schema.scores.summaryZh }).from(schema.scores);
    expect(rows.find((r) => r.id === old?.id)).toEqual({ id: old?.id, summaries: { zh: "旧摘要" }, outputLang: "zh", summaryZh: " 旧摘要 " });
    expect(rows.find((r) => r.id === bare?.id)).toMatchObject({ summaries: {}, outputLang: null });
  });
});

describe("one scoring run", () => {
  it("scores every job that passes the filter and stores the result", async () => {
    const a = await addJob({ title: "Job A", age: 1 });
    const b = await addJob({ title: "Job B", age: 2 });
    const fake = fakeAi();
    fake.replies.set("Job A", answer({ score: 88, fit_reasons: ["理由A"], gaps: ["差距A"], summary_zh: "摘要A", summary_en: "Summary A" }));
    const result = await runScoring(deps(fake), { limit: 10 });

    expect(result).toMatchObject({ candidates: 2, scored: 2, failed: 0, providers: { "claude-cli": 2 }, backlog: { unscored: 0, stale: 0 } });
    const row = await latest(a);
    expect(row).toMatchObject({
      filterResult: "passed",
      score: 88,
      aiScore: 88,
      germanPenalty: 0,
      signalBonus: 0,
      rankValue: 88,
      fitReasons: ["理由A"],
      gaps: ["差距A"],
      summaryZh: "摘要A",
      summaryEn: "Summary A",
      // The summaries per language and the language of the reasons, the old columns still written
      summaries: { zh: "摘要A", en: "Summary A" },
      outputLang: "zh",
      provider: "claude-cli",
      model: "fake-model",
      promptVersion: SCORE_PROMPT_VERSION,
      stale: false,
    });
    expect(row.scoredAt).toBeInstanceOf(Date); // the database clock
    expect(row.profileSnapshotId).not.toBeNull();
    expect((await latest(b)).score).toBe(80);
  });

  it("records one snapshot per profile file and files the scores under the one saved last", async () => {
    await addJob({ title: "Job A" });
    await runScoring(deps(fakeAi()), { limit: 10 });
    const me = await listProfileSnapshots(getDb(), "me", 5);
    const prefs = await listProfileSnapshots(getDb(), "preferences", 5);
    expect(me).toHaveLength(1);
    expect(prefs).toHaveLength(1);
    const [row] = await getDb().select().from(schema.scores);
    expect(row?.profileSnapshotId).toBe(prefs[0]?.id); // preferences were recorded last
    // a second run adds no snapshots
    await addJob({ title: "Job B" });
    await runScoring(deps(fakeAi()), { limit: 10 });
    expect(await listProfileSnapshots(getDb(), "me", 5)).toHaveLength(1);
  });

  it("never scores filtered-out jobs, closed jobs or jobs that already have a fresh score", async () => {
    const snapshot = await currentSnapshot();
    const filtered = await addJob({ title: "Filtered", filter: "none" });
    await getDb().insert(schema.scores).values({ jobId: filtered, profileSnapshotId: snapshot, filterResult: "filtered_out", filterReasons: ["Student position"] });
    const filteredNow = await addJob({ title: "Filtered by the new preferences", filter: "none" });
    // it passed under an older snapshot and was scored then; under the current one it is filtered out
    const older = (await getDb().insert(schema.profileSnapshots).values({ kind: "preferences", contentYaml: "old", hash: "old" }).returning())[0]!;
    await getDb().insert(schema.scores).values({ jobId: filteredNow, profileSnapshotId: older.id, filterResult: "passed", score: 80, rankValue: 80 });
    await getDb().insert(schema.scores).values({ jobId: filteredNow, profileSnapshotId: snapshot, filterResult: "filtered_out", filterReasons: ["x"] });
    const closed = await addJob({ title: "Closed", status: "closed", filter: "none" });
    const possibly = await addJob({ title: "Possibly closed", status: "possibly_closed", filter: "none" });
    const done = await addJob({ title: "Done", filter: "none" });
    await getDb().insert(schema.scores).values({ jobId: done, profileSnapshotId: snapshot, filterResult: "passed", score: 70, rankValue: 70 });
    const open = await addJob({ title: "Open" });
    const passedNoScore = await addJob({ title: "Passed, not scored yet" });
    const unfiltered = await addJob({ title: "Not filtered yet", filter: "none" });

    const fake = fakeAi();
    const result = await runScoring(deps(fake), { limit: 10 });
    expect(fake.calls.sort()).toEqual(["Open", "Passed, not scored yet"]);
    // a job the filter step has not made a row for is left alone; the filter runs before `ai` in the next cycle
    expect(await scoreRows(unfiltered)).toHaveLength(0);
    expect(result.scored).toBe(2);
    expect((await scoreRows(filtered)).map((r) => r.score)).toEqual([null]);
    expect((await scoreRows(filteredNow)).map((r) => r.score).sort()).toEqual([80, null].sort());
    expect(await scoreRows(closed)).toHaveLength(0);
    expect(await scoreRows(possibly)).toHaveLength(0);
    expect((await latest(done)).score).toBe(70);
    expect((await latest(open)).score).toBe(80);
    // the row the hard filter made is filled in, not duplicated
    expect(await scoreRows(passedNoScore)).toHaveLength(1);
    expect((await latest(passedNoScore)).score).toBe(80);
  });

  it("fills in the new snapshot's row after a preferences change and leaves the old row as it was", async () => {
    const old = (await getDb().insert(schema.profileSnapshots).values({ kind: "preferences", contentYaml: "old", hash: "old2" }).returning())[0]!;
    const id = await addJob({ title: "Re-filtered", filter: "none" });
    await getDb().insert(schema.scores).values({ jobId: id, profileSnapshotId: old.id, filterResult: "passed", score: 64, rankValue: 64, stale: true, provider: "old" });
    const snapshot = await currentSnapshot();
    await getDb().insert(schema.scores).values({ jobId: id, profileSnapshotId: snapshot, filterResult: "passed" }); // the filter step's row
    await runScoring(deps(fakeAi()), { limit: 5 });
    const rows = await scoreRows(id);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.profileSnapshotId === snapshot)).toMatchObject({ score: 80, stale: false, provider: "claude-cli" });
    expect(rows.find((r) => r.profileSnapshotId === old.id)).toMatchObject({ score: 64, stale: true, provider: "old" });
  });

  it("works through at most `limit` jobs per run, newest first, and leaves the rest for the next run", async () => {
    const ids: Record<string, number> = {};
    for (const [title, age] of [["Oldest", 50], ["Old", 40], ["Middle", 30], ["Newer", 20], ["Newest", 10]] as const) ids[title] = await addJob({ title, age });
    const fake = fakeAi();

    const first = await runScoring(deps(fake), { limit: 2 });
    expect(first).toMatchObject({ candidates: 2, scored: 2, backlog: { unscored: 3, stale: 0 } });
    expect([...fake.calls].sort()).toEqual(["Newer", "Newest"]);

    const second = await runScoring(deps(fake), { limit: 2 });
    expect(second).toMatchObject({ scored: 2, backlog: { unscored: 1, stale: 0 } });
    expect(fake.calls.slice(2).sort()).toEqual(["Middle", "Old"]);

    const third = await runScoring(deps(fake), { limit: 2 });
    expect(third).toMatchObject({ scored: 1, backlog: { unscored: 0, stale: 0 } });
    expect(fake.calls.at(-1)).toBe("Oldest");
    expect((await latest(ids.Oldest!)).score).toBe(80);

    // nothing left: no AI call
    const before = fake.calls.length;
    expect(await runScoring(deps(fake), { limit: 2 })).toMatchObject({ candidates: 0, scored: 0 });
    expect(fake.calls).toHaveLength(before);
  });

  it("scores a job without a description from its title and says so in the prompt", async () => {
    const id = await addJob({ title: "No text", description: null });
    const seen: string[] = [];
    const fake = fakeAi();
    const original = fake.router.run.bind(fake.router);
    fake.router.run = (task, prompt, schema, opts) => {
      seen.push(prompt.user);
      return original(task, prompt, schema, opts);
    };
    await runScoring(deps(fake), { limit: 5 });
    expect(seen[0]).toContain("the source gave no description");
    expect((await latest(id)).score).toBe(80);
  });

  it("does nothing when the profile is empty", async () => {
    await addJob({ title: "Job A" });
    const fake = fakeAi();
    const empty = exampleMe((raw) => { raw.summary = ""; raw.skills = []; });
    const result = await runScoring(deps(fake, { loadProfile: async () => profile(empty) }), { limit: 5 });
    expect(result).toMatchObject({ stopped: "profile_incomplete", profileMissing: ["summary", "skills"], scored: 0, candidates: 0 });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("German level", () => {
  it("takes points off the match score in code and records how the level was settled", async () => {
    const id = await addJob({ title: "German job", german: "C1", description: "Fließend Deutsch (C1) erforderlich." });
    const fake = fakeAi();
    fake.replies.set("German job", answer({ score: 85, german_level_required: "C1" }));
    await runScoring(deps(fake), { limit: 5 });
    expect(await latest(id)).toMatchObject({ aiScore: 85, germanPenalty: 20, score: 65, rankValue: 65, germanLevel: "C1", germanLevelAi: "C1", germanLevelSource: "agree" });
  });

  it("uses the amounts of ai.yaml", async () => {
    const id = await addJob({ title: "German job", german: "B2" });
    const fake = fakeAi();
    fake.replies.set("German job", answer({ score: 70, german_level_required: "B2" }));
    const config = aiConfig((raw) => { (raw.scoring as { language_penalty: unknown }).language_penalty = { B2: 4 }; });
    await runScoring(deps(fake, { config }), { limit: 5 });
    expect(await latest(id)).toMatchObject({ germanPenalty: 4, score: 66 });
  });

  it("does not deduct for B1 or lower, for 'not required', or for a user who speaks that level", async () => {
    const b1 = await addJob({ title: "B1 job", german: "B1" });
    const plus = await addJob({ title: "Plus job", german: "none" });
    const b2 = await addJob({ title: "B2 job", german: "B2" });
    const fake = fakeAi();
    fake.replies.set("B1 job", answer({ german_level_required: "B1" }));
    fake.replies.set("Plus job", answer({ german_level_required: "none" }));
    fake.replies.set("B2 job", answer({ german_level_required: "B2" }));
    const b2Speaker = exampleMe((raw) => { raw.languages = [{ en: "C1" }, { de: "B2" }]; });
    await runScoring(deps(fake, { loadProfile: async () => profile(b2Speaker) }), { limit: 5 });
    expect((await latest(b1)).germanPenalty).toBe(0);
    expect((await latest(plus)).germanPenalty).toBe(0);
    expect((await latest(b2)).germanPenalty).toBe(0);
  });

  it("settles a disagreement by the level the JD names explicitly, and keeps both readings", async () => {
    const id = await addJob({ title: "Disagree", german: "B2", description: "You bring German at C1 level." });
    const fake = fakeAi();
    fake.replies.set("Disagree", answer({ score: 80, german_level_required: "C1" }));
    await runScoring(deps(fake), { limit: 5 });
    expect(await latest(id)).toMatchObject({ germanLevel: "C1", germanLevelAi: "C1", germanLevelSource: "ai_explicit", germanPenalty: 20, score: 60 });
    // the pipeline's fact about the posting is not overwritten (C3)
    const [job] = await getDb().select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(job?.germanLevelRequired).toBe("B2");
  });

  it("falls back to the AI's reading when the rule found nothing", async () => {
    const id = await addJob({ title: "AI only", german: "unknown", description: "Gute Deutschkenntnisse." });
    const fake = fakeAi();
    fake.replies.set("AI only", answer({ score: 80, german_level_required: "B2" }));
    await runScoring(deps(fake), { limit: 5 });
    expect(await latest(id)).toMatchObject({ germanLevel: "B2", germanLevelSource: "ai", germanPenalty: 10 });
  });
});

describe("German level re-check when the pipeline's rule level changed", () => {
  const penalties = aiConfig().scoring.language_penalty;
  const recheck = () => recheckGerman(getDb(), { me: exampleMe(), penalties, bonusCap: 15, pipeline: shippedPipeline() });
  const setRule = (id: number, level: string) => getDb().update(schema.jobs).set({ germanLevelRequired: level }).where(eq(schema.jobs.id, id));

  it("lifts the deduction when the rule now reads German as preferred (Quantexa), without calling the AI", async () => {
    const id = await addJob({ title: "Quantexa-like", german: "C1", description: "Preferred Qualifications Fluent in German and English" });
    const fake = fakeAi();
    fake.replies.set("Quantexa-like", answer({ score: 45, german_level_required: "unknown" }));
    await runScoring(deps(fake), { limit: 5 });
    expect(await latest(id)).toMatchObject({ germanLevel: "C1", germanLevelSource: "rule", germanPenalty: 20, score: 25, rankValue: 25 });

    await setRule(id, "preferred"); // the pipeline was re-run with the improved rules
    await getDb().update(schema.scores).set({ signalBonus: 3, rankValue: 28 }).where(eq(schema.scores.jobId, id));
    expect(await recheck()).toEqual({ checked: 1, updated: 1 });
    expect(await latest(id)).toMatchObject({ germanLevel: "preferred", germanLevelSource: "rule", germanPenalty: 0, aiScore: 45, score: 45, rankValue: 48, stale: false });
    expect(fake.calls).toEqual(["Quantexa-like"]); // scored once, re-checked without the AI
    expect(await recheck()).toEqual({ checked: 1, updated: 0 }); // nothing moved the second time
  });

  it("takes the deduction when the rule now reads a requirement the old one missed (long gap)", async () => {
    const id = await addJob({ title: "gap-like", german: "none", description: "Verhandlungssicheres Deutsch in Wort und Schrift" });
    const fake = fakeAi();
    fake.replies.set("gap-like", answer({ score: 22, german_level_required: "C1" }));
    await runScoring(deps(fake), { limit: 5 });
    expect(await latest(id)).toMatchObject({ germanLevel: "none", germanLevelSource: "rule_preferred", germanPenalty: 0, score: 22 });

    await setRule(id, "C1");
    expect(await recheck()).toEqual({ checked: 1, updated: 1 });
    expect(await latest(id)).toMatchObject({ germanLevel: "C1", germanLevelSource: "agree", germanLevelAi: "C1", germanPenalty: 20, score: 2 });
  });

  it("leaves stale scores and rows without an AI reading alone", async () => {
    const stale = await addJob({ title: "Stale", german: "C1" });
    const fake = fakeAi();
    fake.replies.set("Stale", answer({ score: 70, german_level_required: "C1" }));
    await runScoring(deps(fake), { limit: 5 });
    const unscored = await addJob({ title: "Not scored yet", german: "C1" });
    await getDb().update(schema.scores).set({ stale: true }).where(eq(schema.scores.jobId, stale));
    await setRule(stale, "preferred");
    await setRule(unscored, "preferred");
    expect(await recheck()).toEqual({ checked: 0, updated: 0 });
    expect((await latest(stale)).germanPenalty).toBe(20);
  });

  it("runs at the start of every scoring run and reports how many scores it settled again", async () => {
    const id = await addJob({ title: "Moves", german: "C1", description: "German C1" });
    const fake = fakeAi();
    fake.replies.set("Moves", answer({ score: 60, german_level_required: "unknown" }));
    await runScoring(deps(fake), { limit: 5 });
    await setRule(id, "none");
    const result = await runScoring(deps(fake), { limit: 5 });
    expect(result.germanRechecked).toBe(1);
    expect(await latest(id)).toMatchObject({ germanLevel: "none", germanPenalty: 0, score: 60 });
  });
});

describe("rank value", () => {
  it("adds the signal bonus the signals step wrote on the row, capped by interests.yaml", async () => {
    const id = await addJob({ title: "With signals" });
    await getDb().update(schema.scores).set({ signalBonus: 22 }).where(eq(schema.scores.jobId, id)); // what the signals step writes on the filter step's row
    const fake = fakeAi();
    fake.replies.set("With signals", answer({ score: 70 }));
    await runScoring(deps(fake), { limit: 5 });
    expect(await latest(id)).toMatchObject({ score: 70, signalBonus: 22, rankValue: 85 });
    await runScoring(deps(fake, { loadBonusCap: () => 10 }), { limit: 5 });
    // not stale, so nothing was re-scored: the stored rank stays until the signals step recomputes it
    expect((await latest(id)).rankValue).toBe(85);
  });
});

describe("failures", () => {
  it("skips a posting whose answer stays invalid, scores the others, and retries it next run", async () => {
    const bad = await addJob({ title: "Bad answer", age: 1 });
    const good = await addJob({ title: "Good answer", age: 2 });
    const fake = fakeAi();
    fake.replies.set("Bad answer", '{"score": 300, "fit_reasons": []}');
    const result = await runScoring(deps(fake), { limit: 5 });
    expect(result).toMatchObject({ scored: 1, failed: 1, backlog: { unscored: 1, stale: 0 } });
    expect(result.stopped).toBeUndefined();
    expect(result.failures).toEqual([{ jobId: bad, reason: expect.stringContaining("AiUnavailableError") }]);
    expect((await latest(bad)).score).toBeNull(); // the filter step's row stays unscored
    expect((await latest(good)).score).toBe(80);

    fake.replies.set("Bad answer", answer({ score: 61 }));
    expect(await runScoring(deps(fake), { limit: 5 })).toMatchObject({ scored: 1, failed: 0 });
    expect((await latest(bad)).score).toBe(61);
  });

  it("stops the run when no provider works, instead of spending the limit on it", async () => {
    for (let i = 0; i < 6; i += 1) await addJob({ title: `Job ${i}`, age: i + 1 });
    const fake = fakeAi();
    for (let i = 0; i < 6; i += 1) fake.replies.set(`Job ${i}`, new AiProviderError("claude-cli", "rate_limited", "usage limit reached"));
    const config = aiConfig((raw) => { (raw.scoring as { concurrency: number }).concurrency = 1; });
    const result = await runScoring(deps(fake, { config }), { limit: 6 });
    expect(result).toMatchObject({ scored: 0, failed: 1, stopped: "ai_unavailable", backlog: { unscored: 6, stale: 0 } });
    expect(fake.calls).toHaveLength(1);
  });

  it("stops at a cancelled cycle", async () => {
    for (let i = 0; i < 4; i += 1) await addJob({ title: `Job ${i}`, age: i + 1 });
    const controller = new AbortController();
    controller.abort();
    const fake = fakeAi();
    const result = await runScoring(deps(fake, { signal: controller.signal }), { limit: 4 });
    expect(result).toMatchObject({ scored: 0, stopped: "cancelled" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("stale scores", () => {
  async function scoreOnce(titles: Array<[string, number]>): Promise<number[]> {
    const ids: number[] = [];
    for (const [title, age] of titles) ids.push(await addJob({ title, age }));
    await runScoring(deps(fakeAi()), { limit: 50 });
    return ids;
  }

  it("a profile change makes scores stale; stale scores come after new jobs and are re-scored in place", async () => {
    const [oldJob] = await scoreOnce([["Scored before", 30]]);
    const snapshot = (await listProfileSnapshots(getDb(), "me", 1))[0]!;
    // a different profile version is saved: the old score belongs to another snapshot
    const other = await recordProfileSnapshot(getDb(), "me", "languages: []\n");
    expect(other.staleMarked).toBe(1);
    expect(other.snapshot.id).not.toBe(snapshot.id);
    expect((await latest(oldJob!)).stale).toBe(true);

    const fresh = await addJob({ title: "Brand new", age: 1 });
    const fake = fakeAi();
    fake.replies.set("Scored before", answer({ score: 55 }));
    const first = await runScoring(deps(fake), { limit: 1 });
    expect(fake.calls).toEqual(["Brand new"]); // new jobs first, even though the stale job is older...
    expect(first.backlog).toEqual({ unscored: 0, stale: 1 });
    expect((await latest(fresh)).score).toBe(80);

    await runScoring(deps(fake), { limit: 1 });
    expect(fake.calls).toEqual(["Brand new", "Scored before"]);
    const rows = await scoreRows(oldJob!);
    expect(rows).toHaveLength(1); // updated in place, not duplicated
    expect(rows[0]).toMatchObject({ score: 55, stale: false });
  });

  it("recording an unchanged profile marks nothing stale", async () => {
    await scoreOnce([["A", 1]]);
    const me = (await listProfileSnapshots(getDb(), "me", 1))[0]!;
    const again = await recordProfileSnapshot(getDb(), "me", me.contentYaml);
    expect(again.staleMarked).toBe(0);
  });

  it("a profile file edited by hand is noticed: new snapshot, older scores stale, then re-scored", async () => {
    const [id] = await scoreOnce([["A", 1]]);
    const edited = exampleMe((raw) => { raw.summary = "A different summary of the same person."; });
    const fake = fakeAi();
    await runScoring(deps(fake, { loadProfile: async () => profile(edited) }), { limit: 5 });
    expect(await listProfileSnapshots(getDb(), "me", 5)).toHaveLength(2);
    // stale was marked by the new snapshot, and the same run re-scored it
    expect(fake.calls).toEqual(["A"]);
    expect((await latest(id!)).stale).toBe(false);
  });

  it("marks scores of another prompt version stale, but not scores without a version", async () => {
    const [id] = await scoreOnce([["A", 1]]);
    const seedLike = await addJob({ title: "Seed like", filter: "none" });
    await getDb().insert(schema.scores).values({ jobId: seedLike, filterResult: "passed", score: 60, rankValue: 60 });
    await getDb().update(schema.scores).set({ promptVersion: "score-v0" }).where(eq(schema.scores.jobId, id!));

    const fake = fakeAi();
    const result = await runScoring(deps(fake), { limit: 5 });
    expect(result.staleByPromptVersion).toBe(1); // only "A": the row without a version is left alone
    expect(fake.calls).toContain("A");
    expect((await latest(id!)).promptVersion).toBe(SCORE_PROMPT_VERSION);
    // the hand-made row belongs to no snapshot, so it never counted as stale; the job just gets a row of the current snapshot
    const seedRows = await scoreRows(seedLike);
    expect(seedRows.find((r) => r.profileSnapshotId === null)).toMatchObject({ stale: false, score: 60 });
  });

  it("changed scoring criteria re-score current scores; clearing them goes back to score-v1; the output language does not", async () => {
    const [a, b] = await scoreOnce([["A", 1], ["B", 2]]);
    const criteria = { priorities: ["Applied ML over research"], dealbreakers: [], nice_to_have: [] };
    const withCriteria = { ...aiConfig(), scoring: { ...aiConfig().scoring, criteria } };
    const first = await runScoring(deps(fakeAi(), { config: withCriteria }), { limit: 0 });
    expect(first.staleByPromptVersion).toBe(2);
    await runScoring(deps(fakeAi(), { config: withCriteria }), { limit: 5 });
    expect((await latest(a!)).promptVersion).toMatch(/^score-v1\+c[0-9a-f]{8}$/);
    // English output for the same criteria: no re-scoring, the new scores are just written in English
    const english = await runScoring(deps(fakeAi(), { config: withCriteria, loadOutputLanguages: () => ({ language: "en", also: [] }) }), { limit: 0 });
    expect(english.staleByPromptVersion).toBe(0);
    // cleared criteria: back to score-v1, both re-scored again
    const cleared = await runScoring(deps(fakeAi()), { limit: 0 });
    expect(cleared.staleByPromptVersion).toBe(2);
    expect((await latest(b!)).stale).toBe(true);
  });

  it("writes the reasons in ai.output and one summary per summary language", async () => {
    const id = await addJob({ title: "Job E" });
    const fake = fakeAi();
    fake.replies.set("Job E", JSON.stringify({ score: 77, fit_reasons: ["Python matches"], gaps: [], german_level_required: "unknown", summary_en: "An ML role.", summary_de: "Eine ML-Stelle." }));
    await runScoring(deps(fake, { loadOutputLanguages: () => ({ language: "en", also: ["de"] }) }), { limit: 5 });
    expect(await latest(id)).toMatchObject({ outputLang: "en", summaries: { en: "An ML role.", de: "Eine ML-Stelle." }, summaryEn: "An ML role.", summaryZh: null, fitReasons: ["Python matches"] });
  });

  it("rescoreStale handles stale scores only", async () => {
    const [stale] = await scoreOnce([["Stale one", 5]]);
    await markScoresStaleExcept(getDb(), 987654321);
    expect((await latest(stale!)).stale).toBe(true);
    await addJob({ title: "Unscored", age: 1 });
    const fake = fakeAi();
    const result = await rescoreStale(deps(fake));
    expect(fake.calls).toEqual(["Stale one"]);
    expect(result).toMatchObject({ scored: 1, backlog: { unscored: 1, stale: 0 } });
  });

  it("counts the backlog the way the settings control needs it", async () => {
    await scoreOnce([["A", 1], ["B", 2]]);
    await markScoresStaleExcept(getDb(), 987654321);
    await addJob({ title: "C" });
    const snapshotId = await currentSnapshot();
    expect(await countScoreBacklog(getDb(), snapshotId)).toEqual({ unscored: 1, stale: 2 });
    expect((await listScoreCandidates(getDb(), { snapshotId, limit: 10, only: "stale" })).map((c) => c.title).sort()).toEqual(["A", "B"]);
  });
});

/** Jobs that get a score right away (the first run); `age` in hours. */
async function scoredJobs(titles: Array<[string, number]>): Promise<number[]> {
  const ids: number[] = [];
  for (const [title, age] of titles) ids.push(await addJob({ title, age }));
  await runScoring(deps(fakeAi()), { limit: 50 });
  return ids;
}

describe("the order the AI gets the waiting jobs in", () => {
  it("scores the most relevant jobs first, not the newest: a .NET job posted today waits behind older AI roles", async () => {
    const net = await addJob({ title: "Senior Fullstack-Entwickler .NET & Angular", age: 1 });
    const fde = await addJob({ title: "Staff Forward Deployed Engineer", age: 24 * 9 });
    const ai = await addJob({ title: "Senior AI Engineer – EU", age: 24 * 5 });
    const fake = fakeAi();

    const result = await runScoring(deps(fake), { limit: 2 });
    expect(result).toMatchObject({ candidates: 2, scored: 2, backlog: { unscored: 1, stale: 0 } });
    expect([...fake.calls].sort()).toEqual(["Senior AI Engineer – EU", "Staff Forward Deployed Engineer"]);
    expect((await latest(net)).score).toBeNull();
    expect((await latest(fde)).score).toBe(80);
    expect((await latest(ai)).score).toBe(80);
  });

  it("a stored signal bonus lifts a job over an equally titled one", async () => {
    const plain = await addJob({ title: "Data Engineer", age: 1 });
    const paid = await addJob({ title: "Data Engineer", age: 1 });
    await getDb().update(schema.scores).set({ signalBonus: 15 }).where(eq(schema.scores.jobId, paid));
    const fake = fakeAi();
    await runScoring(deps(fake), { limit: 1 });
    expect((await latest(paid)).score).toBe(80);
    expect((await latest(plain)).score).toBeNull();
  });

  it("the ai.yaml weights decide: with every weight but recency at 0 it is newest first again", async () => {
    await addJob({ title: "Senior AI Engineer", age: 24 * 5 });
    await addJob({ title: "Plain job", age: 1 });
    const fake = fakeAi();
    const config = aiConfig((raw) => {
      const weights = (raw.scoring as { priority: { weights: Record<string, number> } }).priority.weights;
      for (const key of Object.keys(weights)) weights[key] = key === "recency" ? 10 : 0;
    });
    await runScoring(deps(fake, { config }), { limit: 1 });
    expect(fake.calls).toEqual(["Plain job"]);
  });

  it("stale re-scores still come after jobs that never had a score, whatever their relevance", async () => {
    const [stale] = await scoredJobs([["Senior AI Engineer", 5]]);
    await markScoresStaleExcept(getDb(), 987654321);
    await addJob({ title: "Plain job", age: 1 });
    const fake = fakeAi();
    await runScoring(deps(fake), { limit: 1 });
    expect(fake.calls).toEqual(["Plain job"]);
    expect((await latest(stale!)).stale).toBe(true);
  });
});

describe("the backlog and the chosen jobs", () => {
  it("scoreBacklog works through `backlog_per_run` never-scored jobs, separate from the cycle limit, and leaves stale ones alone", async () => {
    const [stale] = await scoredJobs([["Old and stale", 5]]);
    await markScoresStaleExcept(getDb(), 987654321);
    for (const title of ["B1", "B2", "B3", "B4"]) await addJob({ title, age: 2 });
    const config = aiConfig((raw) => {
      (raw.scoring as Record<string, unknown>).backlog_per_run = 3;
      raw.per_cycle_limit = 1;
    });
    const fake = fakeAi(config);
    const result = await scoreBacklog(deps(fake, { config }));
    expect(result).toMatchObject({ candidates: 3, scored: 3, backlog: { unscored: 1, stale: 1 } });
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls).not.toContain("Old and stale");
    expect((await latest(stale!)).stale).toBe(true);
    // the cycle's own limit is untouched: one job
    const cycle = await runScoring(deps(fake, { config }), { limit: config.per_cycle_limit });
    expect(cycle).toMatchObject({ candidates: 1, scored: 1 });
  });

  it("scoreJobs scores exactly the named jobs, in priority order, over any limit, and counts the ones that needed nothing", async () => {
    const a = await addJob({ title: "Plain A", age: 1 });
    const b = await addJob({ title: "Senior AI Engineer", age: 24 * 3 });
    const filtered = await addJob({ title: "Filtered out", filter: "none" });
    const closed = await addJob({ title: "Closed", status: "closed" });
    const other = await addJob({ title: "Not asked for" });
    const fake = fakeAi();
    const result = await scoreJobs(deps(fake), [a, b, a, filtered, closed, 99999]);
    expect(result).toMatchObject({ candidates: 2, scored: 2, skipped: 3 });
    expect(fake.calls).toEqual(["Senior AI Engineer", "Plain A"]); // priority order: the AI role first although it is older
    expect((await latest(other)).score).toBeNull();
    expect((await latest(a)).score).toBe(80);
    expect(await scoreRows(filtered)).toHaveLength(0);
  });

  it("scoreJobs re-scores a stale score of a named job", async () => {
    const [id] = await scoredJobs([["Was scored", 5]]);
    await markScoresStaleExcept(getDb(), 987654321);
    const result = await scoreJobs(deps(fakeAi()), [id!]);
    expect(result).toMatchObject({ scored: 1, skipped: 0 });
    expect((await latest(id!)).stale).toBe(false);
  });
});

describe("stale only ever means a score made under an outdated profile or prompt", () => {
  const stales = async () => (await getDb().select().from(schema.scores)).filter((r) => r.stale);
  const unscoredRows = async () => (await getDb().select().from(schema.scores)).filter((r) => r.score === null);

  /** The filter step of a first cycle: only the preferences snapshot exists, then it files one row per job under it. */
  async function firstCycleFilterRows(passed: number, filteredOut: number): Promise<{ passedIds: number[]; filteredIds: number[]; snapshotId: number }> {
    const snapshotId = (await recordProfileSnapshot(getDb(), "preferences", profile().preferencesYaml)).snapshot.id;
    const passedIds: number[] = [];
    const filteredIds: number[] = [];
    for (let i = 0; i < passed + filteredOut; i += 1) {
      const isPassed = i < passed;
      const id = await addJob({ title: `${isPassed ? "Passed" : "Filtered"} ${i}`, age: i + 1, filter: "none" });
      await getDb().insert(schema.scores).values({ jobId: id, profileSnapshotId: snapshotId, filterResult: isPassed ? "passed" : "filtered_out", filterReasons: isPassed ? [] : ["title:x"] });
      (isPassed ? passedIds : filteredIds).push(id);
    }
    return { passedIds, filteredIds, snapshotId };
  }

  it("a first cycle (filter rows, then AI scoring of some of them) leaves no unscored row stale", async () => {
    const { passedIds, filteredIds } = await firstCycleFilterRows(5, 4);
    const fake = fakeAi();
    // the ai step runs after the filter step and records the me.yaml snapshot for the first time
    const result = await runScoring(deps(fake), { limit: 2 });
    expect(result).toMatchObject({ scored: 2, staleByPromptVersion: 0, backlog: { unscored: 3, stale: 0 } });

    const rows = await getDb().select().from(schema.scores);
    expect(rows).toHaveLength(9);
    expect(rows.filter((r) => r.score !== null)).toHaveLength(2);
    expect(await stales()).toEqual([]);
    expect(await countStaleScores(getDb())).toBe(0);

    // what the dashboard shows: scored rows fresh, waiting rows are not outdated, filtered-out rows neither
    const page = await listJobs(getDb(), { filters: { includeFiltered: true }, sort: "rank", page: 1, pageSize: 50, timezone: "UTC" });
    expect(page.jobs).toHaveLength(9);
    expect(page.jobs.filter((j) => j.rank?.stale)).toEqual([]);
    for (const id of [...passedIds, ...filteredIds]) expect((await getJobDetail(getDb(), id))?.score?.stale).toBe(false);
  });

  it("a prompt version bump makes only rows that have a score stale", async () => {
    await firstCycleFilterRows(3, 2);
    await runScoring(deps(fakeAi()), { limit: 2 });
    // old rows of every kind carry the old prompt version, as if an older build had written them
    await getDb().update(schema.scores).set({ promptVersion: "score-v0" });
    const marked = await runScoring(deps(fakeAi()), { limit: 0 });
    expect(marked.staleByPromptVersion).toBe(2);
    const stale = await stales();
    expect(stale).toHaveLength(2);
    expect(stale.every((r) => r.score !== null)).toBe(true);
    expect((await unscoredRows()).filter((r) => r.stale)).toEqual([]);
    expect(await countStaleScores(getDb())).toBe(2);
  });

  it("a profile change makes old-snapshot rows with a score stale; unscored and new-snapshot rows stay fresh", async () => {
    const { passedIds, filteredIds, snapshotId } = await firstCycleFilterRows(3, 2);
    await runScoring(deps(fakeAi()), { limit: 2 });

    const changed = await recordProfileSnapshot(getDb(), "preferences", "{}\n");
    expect(changed.snapshot.id).not.toBe(snapshotId);
    expect(changed.staleMarked).toBe(2);
    // the filter step of the next cycle files fresh rows under the new snapshot
    for (const id of [...passedIds, ...filteredIds]) {
      await getDb().insert(schema.scores).values({ jobId: id, profileSnapshotId: changed.snapshot.id, filterResult: passedIds.includes(id) ? "passed" : "filtered_out" });
    }
    const rows = await getDb().select().from(schema.scores);
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.stale).toBe(row.profileSnapshotId === snapshotId && row.score !== null);
    }
    expect(await countStaleScores(getDb())).toBe(2);
  });

  it("the rescore count is the number of stale rows with a score, and the rescore candidates match it", async () => {
    const { snapshotId } = await firstCycleFilterRows(4, 3);
    await runScoring(deps(fakeAi()), { limit: 3 });
    // me.yaml changed: the three scores are outdated, the unscored and filtered-out rows are not
    const changedMe = await recordProfileSnapshot(getDb(), "me", "languages: []\n");
    expect(changedMe.staleMarked).toBe(3);
    expect(await countStaleScores(getDb())).toBe(3);
    expect((await listScoreCandidates(getDb(), { snapshotId, limit: 50, only: "stale" })).map((c) => c.existing.hasScore)).toEqual([true, true, true]);
    expect(await countScoreBacklog(getDb(), snapshotId)).toEqual({ unscored: 1, stale: 3 });

    const fake = fakeAi();
    const result = await rescoreStale(deps(fake, { loadProfile: async () => profile(exampleMe((raw) => { raw.languages = []; })) }), { limit: 50 });
    expect(result.candidates).toBe(3); // not 3 + the unscored passed row + filtered-out rows
    expect(fake.calls).toHaveLength(3);
  });

  it("old data: a stale flag on a row without a score is not shown, and the migration resets it", async () => {
    const { passedIds, filteredIds } = await firstCycleFilterRows(1, 1);
    await getDb().update(schema.scores).set({ stale: true }); // what the bug left behind
    const detail = await getJobDetail(getDb(), passedIds[0]!);
    expect(detail?.score).toMatchObject({ filterResult: "passed", stale: false });
    const page = await listJobs(getDb(), { filters: { includeFiltered: true }, sort: "rank", page: 1, pageSize: 50, timezone: "UTC" });
    expect(page.jobs.map((j) => j.rank?.stale)).toEqual([false, false]);
    expect(await countStaleScores(getDb())).toBe(0);

    const migration = fs.readFileSync(path.resolve(import.meta.dirname, "../../drizzle/0008_scores_stale_fix.sql"), "utf8");
    await getDb().insert(schema.scores).values({ jobId: filteredIds[0]!, profileSnapshotId: null, filterResult: "passed", score: 50, rankValue: 50, stale: true });
    await getDb().execute(sql.raw(migration));
    const rows = await getDb().select().from(schema.scores);
    expect(rows.filter((r) => r.stale).map((r) => r.score)).toEqual([50]); // a real stale score stays
    expect(await unscoredRows()).toHaveLength(2);
  });
});

describe("the `score` sub-task in the ai step", () => {
  let profileDir: string;
  // the suite's own value (an empty temp dir): later tests must not fall back to <app>/data/profile
  const savedProfileDir = process.env.JOB_RADAR_PROFILE_DIR;

  beforeAll(() => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-score-profile-"));
    process.env.JOB_RADAR_PROFILE_DIR = profileDir;
    resetConfigCache();
  });
  afterAll(() => {
    if (savedProfileDir === undefined) delete process.env.JOB_RADAR_PROFILE_DIR;
    else process.env.JOB_RADAR_PROFILE_DIR = savedProfileDir;
    resetConfigCache();
    fs.rmSync(profileDir, { recursive: true, force: true });
    resetAiSubtasks();
  });
  beforeEach(() => resetAiSubtasks());

  const stepContext = (db: ReturnType<typeof getDb> | null, over: Partial<CycleStepContext> = {}): CycleStepContext => ({
    cycle: { id: null, kind: "manual" },
    windowKind: null,
    dryRun: false,
    db,
    signal: new AbortController().signal,
    logger: quietLogger,
    now: () => NOW,
    config: cycleConfig(),
    channels: undefined as never,
    results: {},
    ...over,
  });

  const writeProfile = (me = exampleMe()) => {
    fs.writeFileSync(path.join(profileDir, "me.yaml"), stringify(me));
    fs.writeFileSync(path.join(profileDir, "preferences.yaml"), stringify(examplePreferences()));
  };

  it("scores up to per_cycle_limit postings through the normal step, and reports the result", async () => {
    writeProfile();
    for (let i = 0; i < 5; i += 1) await addJob({ title: `Job ${i}`, age: i + 1 });
    const fake = fakeAi();
    const config = aiConfig((raw) => { raw.per_cycle_limit = 3; });
    registerScoringSubtask();
    const outcome = await createAiStep({ loadAiConfig: () => config, createRouter: () => fake.router })(stepContext(getDb()));
    expect(outcome).toMatchObject({
      status: "ok",
      result: { subtasks: [{ name: SCORE_SUBTASK_NAME, status: "ok", result: { candidates: 3, scored: 3, failed: 0, backlog: { unscored: 2, stale: 0 } } }] },
    });
    expect((await getDb().select().from(schema.scores)).filter((r) => r.score !== null)).toHaveLength(3);
  });

  it("fails the sub-task when every posting failed", async () => {
    writeProfile();
    await addJob({ title: "Only job" });
    const fake = fakeAi();
    fake.replies.set("Only job", new AiProviderError("claude-cli", "auth", "login expired"));
    registerScoringSubtask();
    const outcome = await createAiStep({ loadAiConfig: () => aiConfig(), createRouter: () => fake.router })(stepContext(getDb()));
    expect(outcome).toMatchObject({ status: "failed", result: { subtasks: [{ name: SCORE_SUBTASK_NAME, status: "failed", error: expect.stringContaining("scoring failed for all 1") }] } });
  });

  it("does nothing in a dry run", async () => {
    writeProfile();
    await addJob({ title: "Job" });
    const fake = fakeAi();
    registerScoringSubtask();
    const outcome = await createAiStep({ loadAiConfig: () => aiConfig(), createRouter: () => fake.router })(stepContext(null, { dryRun: true }));
    expect(outcome).toMatchObject({ result: { subtasks: [{ name: SCORE_SUBTASK_NAME, status: "ok", result: { skipped: "dry run" } }] } });
    expect(fake.calls).toHaveLength(0);
  });

  it("is replaced, not duplicated, when registered twice", () => {
    registerAiSubtask({ name: SCORE_SUBTASK_NAME, run: async () => 1 });
    registerScoringSubtask();
    // registering again must not throw or add a second entry
    registerScoringSubtask();
  });
});

describe("dashboard queries", () => {
  it("shows the settled German level, and can hide jobs that need more German than the user has", async () => {
    const german = await addJob({ title: "Needs C1", german: "unknown", filter: "none" });
    const plain = await addJob({ title: "Plain", filter: "none" });
    const ruleOnly = await addJob({ title: "Rule says B2", german: "B2", filter: "none" });
    await getDb().insert(schema.scores).values([
      { jobId: german, filterResult: "passed", score: 60, rankValue: 60, germanLevel: "C1" },
      { jobId: plain, filterResult: "passed", score: 70, rankValue: 70, germanLevel: "none" },
    ]);

    const all = await listJobs(getDb(), { filters: {}, sort: "rank", page: 1, pageSize: 50, timezone: "UTC" });
    const level = (title: string) => all.jobs.find((j) => j.title === title)?.germanLevelRequired;
    expect(level("Needs C1")).toBe("C1"); // from the score, though the pipeline rule said unknown
    expect(level("Plain")).toBe("none");
    expect(level("Rule says B2")).toBe("B2"); // not scored yet: the rule value

    const hidden = await listJobs(getDb(), { filters: { hideGermanLevels: ["B2", "C1", "C2"] }, sort: "rank", page: 1, pageSize: 50, timezone: "UTC" });
    expect(hidden.jobs.map((j) => j.title)).toEqual(["Plain"]);
    expect(hidden.total).toBe(1);

    const today = await listTodayJobs(getDb(), { now: NOW, timezone: "UTC", hideGermanLevels: ["B2", "C1", "C2"] });
    expect(today.map((j) => j.title)).toEqual(["Plain"]);
    expect((await listTodayJobs(getDb(), { now: NOW, timezone: "UTC" })).map((j) => j.title).sort()).toEqual(["Needs C1", "Plain", "Rule says B2"]);
    void ruleOnly;
  });

  it("the detail page gets the score breakdown", async () => {
    const id = await addJob({ title: "Detailed", german: "C1" });
    const fake = fakeAi();
    fake.replies.set("Detailed", answer({ score: 90, german_level_required: "C1" }));
    await runScoring(deps(fake), { limit: 5 });
    const detail = await getJobDetail(getDb(), id);
    expect(detail?.germanLevelRequired).toBe("C1");
    expect(detail?.germanLevelRule).toBe("C1");
    expect(detail?.score).toMatchObject({
      aiScore: 90,
      germanPenalty: 20,
      score: 70,
      rankValue: 70,
      germanLevel: "C1",
      germanLevelAi: "C1",
      germanLevelSource: "agree",
      provider: "claude-cli",
      model: "fake-model",
      promptVersion: SCORE_PROMPT_VERSION,
      stale: false,
    });
  });

  it("keeps showing the last score, marked stale, while the new snapshot's row waits to be scored", async () => {
    const old = (await getDb().insert(schema.profileSnapshots).values({ kind: "preferences", contentYaml: "o", hash: "o" }).returning())[0]!;
    const next = (await getDb().insert(schema.profileSnapshots).values({ kind: "preferences", contentYaml: "n", hash: "n" }).returning())[0]!;
    const id = await addJob({ title: "Waiting for re-score", german: "B2", filter: "none" });
    await getDb().insert(schema.scores).values({ jobId: id, profileSnapshotId: old.id, filterResult: "passed", score: 72, rankValue: 77, signalBonus: 5, germanLevel: "B2", aiScore: 82, germanPenalty: 10, fitReasons: ["fit"], provider: "p" });
    await getDb().insert(schema.scores).values({ jobId: id, profileSnapshotId: next.id, filterResult: "passed" });

    const page = await listJobs(getDb(), { filters: {}, sort: "rank", page: 1, pageSize: 50, timezone: "UTC" });
    expect(page.jobs[0]?.rank).toMatchObject({ score: 72, rankValue: 77, signalBonus: 5, filterResult: "passed", stale: true });
    expect(page.jobs[0]?.germanLevelRequired).toBe("B2");
    const today = await listTodayJobs(getDb(), { now: NOW, timezone: "UTC" });
    expect(today[0]?.rank).toMatchObject({ rankValue: 77, stale: true });

    const detail = await getJobDetail(getDb(), id);
    expect(detail?.score).toMatchObject({ score: 72, rankValue: 77, aiScore: 82, germanPenalty: 10, fitReasons: ["fit"], stale: true, filterResult: "passed" });

    // once the new row is scored it takes over, and it is fresh
    await getDb().update(schema.scores).set({ score: 60, rankValue: 60 }).where(eq(schema.scores.profileSnapshotId, next.id));
    expect((await listJobs(getDb(), { filters: {}, sort: "rank", page: 1, pageSize: 50, timezone: "UTC" })).jobs[0]?.rank).toMatchObject({ score: 60, stale: false });
  });

  it("shows the newest filter result even when an older row has a score", async () => {
    const old = (await getDb().insert(schema.profileSnapshots).values({ kind: "preferences", contentYaml: "o", hash: "o3" }).returning())[0]!;
    const next = (await getDb().insert(schema.profileSnapshots).values({ kind: "preferences", contentYaml: "n", hash: "n3" }).returning())[0]!;
    const id = await addJob({ title: "Now filtered out", filter: "none" });
    await getDb().insert(schema.scores).values({ jobId: id, profileSnapshotId: old.id, filterResult: "passed", score: 90, rankValue: 90 });
    await getDb().insert(schema.scores).values({ jobId: id, profileSnapshotId: next.id, filterResult: "filtered_out", filterReasons: ["blacklist"] });
    const page = await listJobs(getDb(), { filters: { includeFiltered: true }, sort: "rank", page: 1, pageSize: 50, timezone: "UTC" });
    expect(page.jobs[0]?.rank).toMatchObject({ filterResult: "filtered_out", filterReasons: ["blacklist"], rankValue: null });
    expect((await getJobDetail(getDb(), id))?.score).toMatchObject({ filterResult: "filtered_out", rankValue: null });
  });

  it("marks a stale score on the card", async () => {
    const id = await addJob({ title: "Old score", filter: "none" });
    await getDb().insert(schema.scores).values({ jobId: id, filterResult: "passed", score: 60, rankValue: 60, stale: true });
    const page = await listJobs(getDb(), { filters: {}, sort: "rank", page: 1, pageSize: 50, timezone: "UTC" });
    expect(page.jobs[0]?.rank).toMatchObject({ score: 60, stale: true });
  });
});

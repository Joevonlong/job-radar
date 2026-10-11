/**
 * Deal-breakers on a real database: the filter step vetoes in place (no new snapshot, no stale score), the preview counts
 * what the filter step then vetoes, and a vetoed job never reaches the score queue.
 */
import fs from "node:fs";

import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import YAML from "yaml";

import { createLogger } from "@/lib/channels/logger";
import { ensureProfileFiles, getConfigPath, reloadConfig, resetConfigCache, setOnProfileSaved } from "@/lib/config";
import { closeDb, getDb, listProfileSnapshots, listScoreQueue, schema, setFilterOverride } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { currentMe, currentPreferences, filterStep, runFilter, vmTimeBox, type FilterRunResult } from "@/lib/filter";
import type { TimeBox } from "@/lib/filter/deal-breakers";
import { dealBreakerSchema } from "@/lib/config/schemas/preferences";
import { loadPipeline } from "@/lib/market";
import { previewDealBreakers } from "@/lib/profile/deal-breaker-preview";
import { dealBreakerToDraft, preferencesConfigToDraft } from "@/lib/profile/draft";
import { saveProfile } from "@/lib/profile/service";

import { makeTempConfig, type TempConfig } from "../config/helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const url = inject("testDatabaseUrl");
let temp: TempConfig;

const GATE = { id: "german-gate", label: "German above mine", type: "language_gate" };
const ONSITE = { id: "onsite", label: "Fully on-site", type: "phrase", patterns: ["100\\s?%\\s*(?:on-?site|vor Ort)"], scope: "description" };

/** Rewrite a profile file by hand (what `pnpm config:…` or an editor does) and drop the cached copy. */
function editProfile(name: "preferences" | "me", edit: (raw: Record<string, unknown>) => void): string {
  const file = getConfigPath(name);
  const raw = YAML.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  edit(raw);
  const text = YAML.stringify(raw);
  fs.writeFileSync(file, text);
  resetConfigCache();
  return text;
}

const setRules = (rules: unknown[]) => editProfile("preferences", (raw) => void (raw.deal_breakers = rules));
const setGermanLevel = (level: string) => editProfile("me", (raw) => void (raw.languages = [{ en: "native" }, { de: level }]));

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

afterAll(async () => {
  setOnProfileSaved(null);
  await closeDb();
});

beforeEach(async () => {
  temp = makeTempConfig();
  await ensureProfileFiles();
  // a German market (it has a local-language step) around Berlin, no salary floor in the way
  editProfile("preferences", (raw) => {
    raw.market = { pack: "de" };
    raw.locations = ["Berlin"];
    raw.salary_floor_year = 0;
    delete raw.deal_breakers;
  });
  setGermanLevel("B1");
  const db = getDb();
  await db.delete(schema.scores);
  await db.delete(schema.jobs);
  await db.delete(schema.companies);
  await db.delete(schema.profileSnapshots);
});

afterEach(() => temp.cleanup());

let seq = 0;
async function addJob(over: Partial<typeof schema.jobs.$inferInsert> = {}) {
  const db = getDb();
  seq += 1;
  const [company] = await db.insert(schema.companies).values({ name: `Acme ${seq}`, nameNorm: `acme-${seq}-${Math.random()}` }).returning();
  if (!company) throw new Error("company");
  const [job] = await db
    .insert(schema.jobs)
    .values({
      companyId: company.id,
      title: `Data Engineer ${seq}`,
      titleNorm: `data engineer ${seq}`,
      locationsJson: [{ label: "Berlin", city: "Berlin", countryCode: "DE", isPrimary: true }],
      workplace: "hybrid",
      contract: "permanent",
      description: "We build data pipelines. Hybrid work in Berlin.",
      ...over,
    })
    .returning();
  if (!job) throw new Error("job");
  return job;
}

const silent = createLogger({ sink: () => {} });
const runStep = async (): Promise<FilterRunResult> => {
  const outcome = await filterStep({ db: getDb(), signal: new AbortController().signal, logger: silent } as unknown as Parameters<typeof filterStep>[0]);
  return outcome.result as FilterRunResult;
};
const rowsOf = (jobId: number) => getDb().select().from(schema.scores).where(eq(schema.scores.jobId, jobId)).orderBy(asc(schema.scores.id));
const snapshots = () => listProfileSnapshots(getDb(), "preferences", 10);

/** Save preferences the way the /me form does. */
async function saveFromForm(edit: (draft: ReturnType<typeof preferencesConfigToDraft>) => ReturnType<typeof preferencesConfigToDraft>) {
  const draft = preferencesConfigToDraft(reloadConfig("preferences"));
  const result = await saveProfile("preferences", edit(draft));
  expect(result.status).toBe("saved");
}
const draftRules = (rules: unknown[]) => rules.map((rule) => dealBreakerToDraft(dealBreakerSchema.parse(rule)));

describe("the filter step applies deal-breakers", () => {
  it("vetoes by the pipeline's own reading of the required level, in place and idempotently", async () => {
    const above = await addJob({ germanLevelRequired: "C1" });
    const mine = await addJob({ germanLevelRequired: "B1" });
    const preferred = await addJob({ germanLevelRequired: "preferred" });
    const unknown = await addJob();
    const first = await runStep();
    expect(first).toMatchObject({ evaluated: 4, created: 4, filteredOut: 0 });

    setRules([GATE]);
    const second = await runStep();
    // only deal_breakers changed: the same snapshot, its rows updated in place
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second).toMatchObject({ evaluated: 4, created: 0, updated: 1, unchanged: 3, filteredOut: 1 });
    expect(second.byReason).toEqual({ deal_breaker: 1 });
    expect(await rowsOf(above.id)).toMatchObject([{ filterResult: "filtered_out", filterReasons: ["deal_breaker:german-gate"] }]);
    for (const job of [mine, preferred, unknown]) expect(await rowsOf(job.id)).toMatchObject([{ filterResult: "passed", filterReasons: [] }]);
    expect(await snapshots()).toHaveLength(1);

    const again = await runStep();
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 4 });
  });

  it("reads jobs.german_level_required only, never the AI's reading of the level", async () => {
    const ruleSaysB1 = await addJob({ germanLevelRequired: "B1" });
    const ruleSaysC1 = await addJob({ germanLevelRequired: "C1" });
    await runStep();
    await getDb().update(schema.scores).set({ germanLevel: "C2", score: 70 }).where(eq(schema.scores.jobId, ruleSaysB1.id));
    await getDb().update(schema.scores).set({ germanLevel: "none", score: 70 }).where(eq(schema.scores.jobId, ruleSaysC1.id));
    setRules([GATE]);
    await runStep();
    expect(await rowsOf(ruleSaysB1.id)).toMatchObject([{ filterResult: "passed" }]);
    expect(await rowsOf(ruleSaysC1.id)).toMatchObject([{ filterResult: "filtered_out", filterReasons: ["deal_breaker:german-gate"] }]);
  });

  it("a changed rule, a removed rule and a changed level in me.yaml update the rows in place", async () => {
    const c1 = await addJob({ germanLevelRequired: "C1" });
    const b2 = await addJob({ germanLevelRequired: "B2" });
    setRules([GATE]);
    const first = await runStep();
    expect(first.filteredOut).toBe(2);

    // a fixed threshold: only C1 and above
    setRules([{ ...GATE, at_least: "C1" }]);
    expect(await runStep()).toMatchObject({ snapshotId: first.snapshotId, updated: 1, filteredOut: 1 });
    expect(await rowsOf(b2.id)).toMatchObject([{ filterResult: "passed" }]);

    // back to "above mine", then the user's level goes up to B2
    setRules([GATE]);
    await runStep();
    setGermanLevel("B2");
    expect(await runStep()).toMatchObject({ snapshotId: first.snapshotId, updated: 1, filteredOut: 1 });
    expect(await rowsOf(b2.id)).toMatchObject([{ filterResult: "passed" }]);
    expect(await rowsOf(c1.id)).toMatchObject([{ filterResult: "filtered_out" }]);

    // the rule goes: the job comes back without a re-score
    setRules([]);
    expect(await runStep()).toMatchObject({ snapshotId: first.snapshotId, updated: 1, filteredOut: 0 });
    expect(await rowsOf(c1.id)).toMatchObject([{ filterResult: "passed", filterReasons: [] }]);
    expect(await snapshots()).toHaveLength(1);
  });

  it("a phrase rule vetoes by the posting's words; a switched-off rule does nothing", async () => {
    const onsite = await addJob({ description: "Great team. Die Stelle ist 100 % vor Ort in Berlin." });
    const hybrid = await addJob();
    setRules([ONSITE]);
    await runStep();
    expect(await rowsOf(onsite.id)).toMatchObject([{ filterResult: "filtered_out", filterReasons: ["deal_breaker:onsite"] }]);
    expect(await rowsOf(hybrid.id)).toMatchObject([{ filterResult: "passed" }]);
    setRules([{ ...ONSITE, enabled: false }]);
    await runStep();
    expect(await rowsOf(onsite.id)).toMatchObject([{ filterResult: "passed", filterReasons: [] }]);
  });

  it("keeps the old score of a vetoed job, takes it out of the score queue, and Keep anyway brings it back", async () => {
    const scored = await addJob({ germanLevelRequired: "C2" });
    const unscored = await addJob({ germanLevelRequired: "C2" });
    const first = await runStep();
    await getDb().update(schema.scores).set({ score: 82, summaryEn: "kept" }).where(eq(schema.scores.jobId, scored.id));
    expect((await listScoreQueue(getDb(), { snapshotId: first.snapshotId })).map((item) => item.jobId)).toEqual([unscored.id]);

    setRules([GATE]);
    await runStep();
    expect(await rowsOf(scored.id)).toMatchObject([{ filterResult: "filtered_out", score: 82, summaryEn: "kept", stale: false }]);
    expect(await listScoreQueue(getDb(), { snapshotId: first.snapshotId })).toEqual([]);

    await setFilterOverride(getDb(), unscored.id, "keep");
    await runStep();
    expect(await rowsOf(unscored.id)).toMatchObject([{ filterResult: "passed", filterReasons: ["override_keep", "deal_breaker:german-gate"] }]);
    expect((await listScoreQueue(getDb(), { snapshotId: first.snapshotId })).map((item) => item.jobId)).toEqual([unscored.id]);
  });

  it("the preview counts exactly what the filter step then vetoes", async () => {
    await addJob({ germanLevelRequired: "C1" });
    await addJob({ germanLevelRequired: "B2", description: "Arbeit 100% on-site." });
    await addJob({ description: "100 % vor Ort." });
    await addJob({ germanLevelRequired: "A2" });
    await addJob({ status: "closed", germanLevelRequired: "C2" });
    setRules([GATE, ONSITE]);
    const { preferences } = await currentPreferences(getDb());
    const preview = await previewDealBreakers(getDb(), preferences.deal_breakers, { pipeline: loadPipeline(), me: currentMe(), sampleLimit: 10, explain: true });
    expect(preview.total).toBe(4);
    expect(preview.rules.map((rule) => [rule.id, rule.status, rule.count])).toEqual([
      ["german-gate", "ok", 2],
      ["onsite", "ok", 2],
    ]);
    expect(preview.rules[1]?.samples.map((sample) => sample.quote)).toEqual(["100% on-site", "100 % vor Ort"].map((quote) => expect.stringContaining(quote)));

    await runStep();
    const rows = await getDb().select().from(schema.scores);
    const vetoedBy = (id: string) => rows.filter((row) => row.filterReasons.includes(`deal_breaker:${id}`)).length;
    expect(vetoedBy("german-gate")).toBe(2);
    expect(vetoedBy("onsite")).toBe(2);
  });

  it("a gate in a market without a local-language step does nothing", async () => {
    editProfile("preferences", (raw) => {
      raw.market = { pack: "generic", country: "US", currency: "USD", home_language: "en" };
      raw.locations = ["New York"];
    });
    const job = await addJob({ germanLevelRequired: "C2", locationsJson: [{ label: "New York", city: "New York", countryCode: "US", isPrimary: true }] });
    setRules([GATE]);
    await runStep();
    expect(await rowsOf(job.id)).toMatchObject([{ filterResult: "passed", filterReasons: [] }]);
  });
});

describe("deal-breakers and profile snapshots", () => {
  async function scoredJob() {
    const job = await addJob();
    const first = await runStep();
    await getDb().update(schema.scores).set({ score: 75 }).where(eq(schema.scores.jobId, job.id));
    return { job, snapshotId: first.snapshotId };
  }

  it("a hand edit of deal_breakers alone keeps the snapshot (given the new text) and nothing goes stale", async () => {
    const { job, snapshotId } = await scoredJob();
    const text = setRules([GATE]);
    const { snapshot } = await currentPreferences(getDb());
    expect(snapshot.id).toBe(snapshotId);
    expect(snapshot.contentYaml).toBe(text);
    expect(await snapshots()).toHaveLength(1);
    expect(await rowsOf(job.id)).toMatchObject([{ score: 75, stale: false }]);
  });

  it("a hand edit of deal_breakers and the salary floor is a real change: a new snapshot, the score stale", async () => {
    const { job, snapshotId } = await scoredJob();
    editProfile("preferences", (raw) => {
      raw.deal_breakers = [GATE];
      raw.salary_floor_year = 50_000;
    });
    const { snapshot } = await currentPreferences(getDb());
    expect(snapshot.id).not.toBe(snapshotId);
    expect(await snapshots()).toHaveLength(2);
    await runStep();
    expect(await rowsOf(job.id)).toMatchObject([{ profileSnapshotId: snapshotId, score: 75, stale: true }, { profileSnapshotId: snapshot.id, score: null }]);
  });

  it("a save from the form: deal_breakers alone keeps the snapshot; with exclude_keywords the score goes stale", async () => {
    const { job, snapshotId } = await scoredJob();
    await saveFromForm((draft) => ({ ...draft, deal_breakers: draftRules([GATE]) }));
    const after = await snapshots();
    expect(after.map((s) => s.id)).toEqual([snapshotId]);
    expect(after[0]?.contentYaml).toBe(fs.readFileSync(getConfigPath("preferences"), "utf8"));
    expect(reloadConfig("preferences").deal_breakers.map((rule) => rule.id)).toEqual(["german-gate"]);
    expect(await rowsOf(job.id)).toMatchObject([{ score: 75, stale: false }]);

    await saveFromForm((draft) => ({ ...draft, exclude_keywords: ["blockchain"] }));
    expect(await snapshots()).toHaveLength(2);
    expect(await rowsOf(job.id)).toMatchObject([{ score: 75, stale: true }]);
  });

  it("a form save of exclude_keywords alone makes the score stale (the hard filter's other words are part of the profile)", async () => {
    const { job } = await scoredJob();
    await saveFromForm((draft) => ({ ...draft, exclude_keywords: ["crypto"] }));
    expect(await snapshots()).toHaveLength(2);
    expect(await rowsOf(job.id)).toMatchObject([{ stale: true }]);
  });
});

describe("slow patterns and unusable rules are bounded and reported", () => {
  // passes the static check (only bounded runs) but takes far longer than match_ms on a long line of digits
  const SLOW = { id: "slow", label: "Slow", type: "phrase", patterns: ["1\\d{0,20000}\\d{0,20000}%"] };

  it("leaves a slow rule out of the filter step and reports it in the step result", async () => {
    const job = await addJob({ description: "Travel 100% of the time, fully on-site." });
    setRules([SLOW, { ...ONSITE, patterns: ["fully on-site"] }]);
    const outcome = await filterStep({ db: getDb(), signal: new AbortController().signal, logger: silent } as unknown as Parameters<typeof filterStep>[0]);
    // partial: the runs view shows that a rule did not judge every job
    expect(outcome.status).toBe("partial");
    expect((outcome.result as FilterRunResult).dealBreakerWarnings).toEqual([{ id: "slow", code: "too_slow" }]);
    expect((await rowsOf(job.id))[0]?.filterReasons).toEqual(["deal_breaker:onsite"]);
  });

  it.each([
    ["left out as too slow on the test texts", (): TimeBox => () => false],
    // the test texts pass (boxes of match_ms), the run's budget is gone at once (boxes of rule_budget_ms)
    ["stopped over its budget", (): TimeBox => (work, ms) => (ms <= loadPipeline().filter.deal_breakers.match_ms ? vmTimeBox(work, ms) : false)],
  ])("keeps a stored veto when the rule is %s in a later run", async (_case, timeBox) => {
    const vetoed = await addJob({ description: "Fully on-site, 100 % vor Ort." });
    const other = await addJob();
    setRules([ONSITE]);
    expect((await runStep()).dealBreakerWarnings).toEqual([]);
    expect((await rowsOf(vetoed.id))[0]?.filterReasons).toEqual(["deal_breaker:onsite"]);

    const { preferences, snapshot, me } = await currentPreferences(getDb());
    const second = await runFilter(getDb(), { preferences, snapshotId: snapshot.id, pipeline: loadPipeline(), me, timeBox: timeBox() });
    expect(second.dealBreakerWarnings).toEqual([{ id: "onsite", code: "too_slow" }]);
    expect(second.updated).toBe(0);
    const rows = await rowsOf(vetoed.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ filterResult: "filtered_out", filterReasons: ["deal_breaker:onsite"] });
    expect((await rowsOf(other.id))[0]?.filterResult).toBe("passed");
    expect((await listScoreQueue(getDb(), { snapshotId: snapshot.id })).map((item) => item.jobId)).not.toContain(vetoed.id);
  });

  it("reports an unreadable me.yaml in the step result (the gate does nothing that cycle)", async () => {
    const job = await addJob({ germanLevelRequired: "C1" });
    setRules([GATE]);
    fs.writeFileSync(getConfigPath("me"), "languages: [\n");
    resetConfigCache();
    const result = await runStep();
    expect(result.dealBreakerWarnings).toEqual([{ id: "german-gate", code: "me_unreadable" }]);
    expect((await rowsOf(job.id))[0]?.filterResult).toBe("passed");
  });

  it("refuses to save a slow pattern from the form, at its field", async () => {
    const draft = preferencesConfigToDraft(reloadConfig("preferences"));
    const result = await saveProfile("preferences", { ...draft, deal_breakers: draftRules([SLOW]) });
    expect(result).toMatchObject({ status: "error", fieldErrors: [{ path: "deal_breakers.0.patterns", key: "slowPattern", params: { kind: "probe" } }] });
  });

  it("says too_slow in the preview, and stops the preview at its deadline", async () => {
    await addJob({ description: "Fully on-site, 100 % vor Ort." });
    const rules = [SLOW, ONSITE].map((rule) => dealBreakerSchema.parse(rule));
    const options = { pipeline: loadPipeline(), me: currentMe(), sampleLimit: 3 };
    const preview = await previewDealBreakers(getDb(), rules, options);
    expect(preview.rules.map((rule) => [rule.status, rule.count])).toEqual([
      ["too_slow", 0],
      ["ok", 1],
    ]);
    expect(preview.partial).toBe(false);
    expect(await previewDealBreakers(getDb(), rules, { ...options, deadlineMs: 0 })).toMatchObject({ total: 0, partial: true });
  });
});

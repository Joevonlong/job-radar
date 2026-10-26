import fs from "node:fs";

import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { setFilterOverrideAction } from "@/app/jobs/[id]/filter-actions";
import { createLogger } from "@/lib/channels/logger";
import { ChannelRegistry } from "@/lib/channels/registry";
import { ensureProfileFiles, getConfigPath, loadConfig, reloadConfig, resetConfigCache, setOnProfileSaved, writeConfig } from "@/lib/config";
import { registerBuiltinCycleSteps } from "@/lib/cycle/builtin-steps";
import { runCycle } from "@/lib/cycle/run-cycle";
import { resetCycleSteps } from "@/lib/cycle/steps";
import { clearFilterOverride, closeDb, getDb, getFilterOverride, listJobs, listProfileSnapshots, listTodayJobs, schema, setFilterOverride } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { currentWatchedCompanies, filterStep, refilterJob, runFilter, currentPreferences, type FilterRunResult } from "@/lib/filter";
import { buildWatchedCompanyKeys } from "@/lib/companies/marks";
import { listPushCandidates } from "@/lib/db";
import { selectForPush } from "@/lib/notify/select";
import { preferencesConfigToDraft } from "@/lib/profile/draft";
import { saveProfile } from "@/lib/profile/service";

import { config } from "../cycle/helpers";
import { makeTempConfig, type TempConfig } from "../config/helpers";
import { shippedPipeline } from "../pipeline/helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const url = inject("testDatabaseUrl");
let temp: TempConfig;

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
  const db = getDb();
  await db.delete(schema.scores);
  await db.delete(schema.jobs);
  await db.delete(schema.companies);
  await db.delete(schema.profileSnapshots);
});

afterEach(() => {
  resetCycleSteps();
  temp.cleanup();
});

let seq = 0;
async function addJob(over: Partial<typeof schema.jobs.$inferInsert> & { company?: string; nameNorm?: string; watched?: boolean } = {}) {
  const db = getDb();
  seq += 1;
  const { company: companyName, nameNorm, watched, ...rest } = over;
  const name = companyName ?? `Acme ${seq}`;
  const [company] = await db
    .insert(schema.companies)
    .values({ name, nameNorm: nameNorm ?? `acme-${seq}-${Math.random()}`, ...(watched === undefined ? {} : { watched }) })
    .returning();
  if (!company) throw new Error("company");
  const [job] = await db
    .insert(schema.jobs)
    .values({
      companyId: company.id,
      title: `AI Engineer ${seq}`,
      titleNorm: `ai engineer ${seq}`,
      locationsJson: [{ label: "Berlin", city: "Berlin", countryCode: "DE", isPrimary: true }],
      workplace: "hybrid",
      contract: "permanent",
      ...rest,
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

async function setFloor(value: number) {
  const draft = preferencesConfigToDraft(reloadConfig("preferences"));
  const result = await saveProfile("preferences", { ...draft, salary_floor_year: String(value) });
  expect(result.status).toBe("saved");
}

const salaryJson = (max: number) => ({
  raw: "x", currency: "EUR", period: "year", min: max - 10_000, max, perYear: { min: max - 10_000, max }, eurPerYear: { min: max - 10_000, max },
  periodAssumed: false, origin: "channel", qualityStatus: "valid", reasonCodes: [],
});

describe("filter step", () => {
  it("stores one result per job under a snapshot of the current preferences", async () => {
    const ok = await addJob();
    const student = await addJob({ contract: "student" });
    const hamburg = await addJob({ locationsJson: [{ label: "Hamburg", city: "Hamburg", countryCode: "DE", isPrimary: true }] });
    const closed = await addJob({ status: "closed", contract: "student" });

    const result = await runStep();
    expect(result).toMatchObject({ evaluated: 3, created: 3, updated: 0, unchanged: 0, passed: 1, filteredOut: 2 });
    expect(result.byReason).toEqual({ student_role: 1, location_not_allowed: 1 });

    const snapshots = await listProfileSnapshots(getDb(), "preferences", 10);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.contentYaml).toBe(fs.readFileSync(getConfigPath("preferences"), "utf8"));
    expect(result.snapshotId).toBe(snapshots[0]?.id);

    expect(await rowsOf(ok.id)).toMatchObject([{ filterResult: "passed", filterReasons: [], profileSnapshotId: snapshots[0]?.id, score: null }]);
    expect(await rowsOf(student.id)).toMatchObject([{ filterResult: "filtered_out", filterReasons: ["student_role"] }]);
    expect(await rowsOf(hamburg.id)).toMatchObject([{ filterResult: "filtered_out", filterReasons: ["location_not_allowed:Hamburg"] }]);
    expect(await rowsOf(closed.id)).toEqual([]);
  });

  it("is idempotent: a second run with the same preferences writes nothing and adds no row", async () => {
    const a = await addJob();
    await addJob({ contract: "student" });
    await runStep();
    const before = await getDb().select().from(schema.scores).orderBy(asc(schema.scores.id));
    const again = await runStep();
    expect(again).toMatchObject({ evaluated: 2, created: 0, updated: 0, unchanged: 2 });
    const after = await getDb().select().from(schema.scores).orderBy(asc(schema.scores.id));
    expect(after).toEqual(before);
    expect(await rowsOf(a.id)).toHaveLength(1);
    expect(await listProfileSnapshots(getDb(), "preferences", 10)).toHaveLength(1);
  });

  it("the database refuses a second result for the same job and snapshot", async () => {
    const job = await addJob();
    await runStep();
    const [row] = await rowsOf(job.id);
    await expect(
      getDb().insert(schema.scores).values({ jobId: job.id, profileSnapshotId: row?.profileSnapshotId ?? null, filterResult: "passed" }),
    ).rejects.toThrow();
    // rows without a snapshot (seed data) are not constrained
    await getDb().insert(schema.scores).values({ jobId: job.id, filterResult: "passed" });
    await getDb().insert(schema.scores).values({ jobId: job.id, filterResult: "passed" });
  });

  it("re-filters when the profile changes: a new snapshot, a new row per job, the old rows stay as they are", async () => {
    const job = await addJob({ salaryJson: salaryJson(75_000) });
    const first = await runStep();
    expect(first.filteredOut).toBe(0);

    await setFloor(90_000);
    const second = await runStep();
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(second).toMatchObject({ evaluated: 1, created: 1, filteredOut: 1 });

    const rows = await rowsOf(job.id);
    expect(rows).toHaveLength(2);
    // the old row has no AI score, so there is nothing in it that could be outdated
    expect(rows[0]).toMatchObject({ profileSnapshotId: first.snapshotId, filterResult: "passed", score: null, stale: false });
    expect(rows[1]).toMatchObject({ profileSnapshotId: second.snapshotId, filterResult: "filtered_out", filterReasons: ["salary_below_floor:75000"], stale: false });

    // the dashboard reads the newest result
    const cards = await listJobs(getDb(), { filters: { includeFiltered: true }, sort: "first_seen", page: 1, pageSize: 20, timezone: "Europe/Berlin" });
    expect(cards.jobs.find((j) => j.id === job.id)?.rank?.filterResult).toBe("filtered_out");
  });

  it("snapshots a hand-edited preferences file", async () => {
    await addJob();
    const file = getConfigPath("preferences");
    fs.writeFileSync(file, `${fs.readFileSync(file, "utf8")}\n# edited by hand\n`);
    const { snapshot } = await currentPreferences(getDb());
    expect(await listProfileSnapshots(getDb(), "preferences", 10)).toHaveLength(1);
    expect((await currentPreferences(getDb())).snapshot.id).toBe(snapshot.id);
  });

  it("updates a result in place when the job itself changed", async () => {
    const job = await addJob({ salaryJson: salaryJson(60_000) });
    const first = await runStep();
    expect(first.filteredOut).toBe(1);
    await getDb().update(schema.jobs).set({ salaryJson: salaryJson(95_000) }).where(eq(schema.jobs.id, job.id));
    // an AI score the row may already carry survives
    await getDb().update(schema.scores).set({ score: 77, summaryEn: "kept" }).where(eq(schema.scores.jobId, job.id));
    const second = await runStep();
    expect(second).toMatchObject({ created: 0, updated: 1, passed: 1 });
    expect(await rowsOf(job.id)).toMatchObject([{ filterResult: "passed", filterReasons: [], score: 77, summaryEn: "kept" }]);
  });

  it("works through batches", async () => {
    for (let i = 0; i < 5; i += 1) await addJob();
    const db = getDb();
    const current = await currentPreferences(db);
    const pipeline = { ...shippedPipeline(), batch_size: 2 };
    const result = await runFilter(db, { preferences: current.preferences, snapshotId: current.snapshot.id, pipeline, me: null });
    expect(result).toMatchObject({ evaluated: 5, created: 5 });
    expect(await db.select().from(schema.scores).where(and(eq(schema.scores.profileSnapshotId, current.snapshot.id)))).toHaveLength(5);
  });

  it("stops at a cancelled signal", async () => {
    await addJob();
    const db = getDb();
    const current = await currentPreferences(db);
    const controller = new AbortController();
    controller.abort();
    const result = await runFilter(db, { preferences: current.preferences, snapshotId: current.snapshot.id, pipeline: shippedPipeline(), me: null, signal: controller.signal });
    expect(result).toMatchObject({ aborted: true, evaluated: 0 });
  });
});

describe("user override", () => {
  const hamburgLocation = [{ label: "Hamburg", city: "Hamburg", countryCode: "DE", isPrimary: true }];

  it("keep survives re-filtering and a new preferences snapshot", async () => {
    const hamburg = await addJob({ locationsJson: hamburgLocation });
    const first = await runStep();
    expect(await rowsOf(hamburg.id)).toMatchObject([{ filterResult: "filtered_out" }]);

    await setFilterOverride(getDb(), hamburg.id, "keep");
    const second = await runStep();
    expect(second).toMatchObject({ updated: 1, passed: 1, filteredOut: 0 });
    expect(await rowsOf(hamburg.id)).toMatchObject([{ profileSnapshotId: first.snapshotId, filterResult: "passed", filterReasons: ["override_keep", "location_not_allowed:Hamburg"] }]);

    // another snapshot (the floor changes): the new row for the job is kept as well
    await setFloor(80_000);
    const third = await runStep();
    expect(third.snapshotId).not.toBe(first.snapshotId);
    const rows = await rowsOf(hamburg.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ profileSnapshotId: third.snapshotId, filterResult: "passed", filterReasons: ["override_keep", "location_not_allowed:Hamburg"] });
    expect(await getFilterOverride(getDb(), hamburg.id)).toBe("keep");
  });

  it("exclude filters a job that passed, and clearing lets the rules decide again", async () => {
    const job = await addJob();
    await runStep();
    await setFilterOverride(getDb(), job.id, "exclude");
    await runStep();
    expect(await rowsOf(job.id)).toMatchObject([{ filterResult: "filtered_out", filterReasons: ["override_exclude"] }]);
    await clearFilterOverride(getDb(), job.id);
    await runStep();
    expect(await rowsOf(job.id)).toMatchObject([{ filterResult: "passed", filterReasons: [] }]);
  });

  it("refilterJob applies the decision to that job only, at once", async () => {
    const hamburg = await addJob({ locationsJson: hamburgLocation });
    const other = await addJob({ locationsJson: hamburgLocation });
    await runStep();
    await setFilterOverride(getDb(), hamburg.id, "keep");
    expect(await refilterJob(getDb(), hamburg.id)).toEqual({ filterResult: "passed", filterReasons: ["override_keep", "location_not_allowed:Hamburg"] });
    expect(await rowsOf(other.id)).toMatchObject([{ filterResult: "filtered_out" }]);
    expect(await refilterJob(getDb(), 999_999)).toBeNull();
  });

  it("the server action stores the decision, re-filters the job and validates its input", async () => {
    const hamburg = await addJob({ locationsJson: hamburgLocation });
    await runStep();
    expect(await setFilterOverrideAction({ jobId: hamburg.id, action: "keep" })).toEqual({ ok: true, filterResult: "passed" });
    expect(await rowsOf(hamburg.id)).toMatchObject([{ filterResult: "passed", filterReasons: ["override_keep", "location_not_allowed:Hamburg"] }]);
    expect(await setFilterOverrideAction({ jobId: hamburg.id, action: "clear" })).toEqual({ ok: true, filterResult: "filtered_out" });
    expect(await getFilterOverride(getDb(), hamburg.id)).toBeNull();
    expect(await setFilterOverrideAction({ jobId: hamburg.id, action: "nope" })).toEqual({ ok: false, error: "invalid" });
    expect(await setFilterOverrideAction({ jobId: 999_999, action: "keep" })).toEqual({ ok: false, error: "not_found" });
  });

  it("keeps the AI score of a row when the decision flips it", async () => {
    const job = await addJob();
    await runStep();
    await getDb().update(schema.scores).set({ score: 71, summaryEn: "kept" }).where(eq(schema.scores.jobId, job.id));
    await setFilterOverride(getDb(), job.id, "exclude");
    await refilterJob(getDb(), job.id);
    expect(await rowsOf(job.id)).toMatchObject([{ filterResult: "filtered_out", score: 71, summaryEn: "kept" }]);
  });

  it("the override goes away with the job and is replaced, not duplicated", async () => {
    const job = await addJob();
    await setFilterOverride(getDb(), job.id, "keep");
    await setFilterOverride(getDb(), job.id, "exclude");
    expect(await getDb().select().from(schema.jobFilterOverrides)).toMatchObject([{ jobId: job.id, action: "exclude" }]);
    await getDb().delete(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(await getDb().select().from(schema.jobFilterOverrides)).toEqual([]);
  });

  it("the filter step marks a metro town and a country-level job as kept (the metro rules on a real database)", async () => {
    const garching = await addJob({ locationsJson: [{ label: "Garching, Bavaria, Germany", city: "Garching", countryCode: "DE", isPrimary: true }] });
    const germany = await addJob({ workplace: "unknown", locationsJson: [{ label: "Germany", city: "Germany", countryCode: "DE", isPrimary: true }] });
    const us = await addJob({ workplace: "remote", locationsJson: [{ label: "Remote - Washington D.C.", city: null, countryCode: null, isPrimary: true }] });
    await runStep();
    expect(await rowsOf(garching.id)).toMatchObject([{ filterResult: "passed", filterReasons: [] }]);
    expect(await rowsOf(germany.id)).toMatchObject([{ filterResult: "passed", filterReasons: ["location_country_level:Germany"] }]);
    expect(await rowsOf(us.id)).toMatchObject([{ filterResult: "filtered_out", filterReasons: ["remote_out_of_scope:Remote - Washington D.C."] }]);
  });
});

describe("watched companies keep their on-site jobs anywhere in the home country", () => {
  const hamburgLocation = [{ label: "Hamburg", city: "Hamburg", countryCode: "DE", isPrimary: true }];
  const setWatched = async (names: string[]) => {
    await writeConfig("interests", { ...loadConfig("interests"), watched_companies: names });
  };
  const hamburgJob = () => addJob({ company: "Orbitrail AG", nameNorm: "orbitrail", workplace: "onsite", locationsJson: hamburgLocation });

  it("follows the watch list: in, out and back, updating the result in place", async () => {
    const job = await hamburgJob();
    await runStep();
    expect(await rowsOf(job.id)).toMatchObject([{ filterResult: "filtered_out", filterReasons: ["location_not_allowed:Hamburg"] }]);

    await setWatched(["Orbitrail GmbH"]); // another legal form: the same company key
    const watched = await runStep();
    expect(watched).toMatchObject({ evaluated: 1, created: 0, updated: 1, passed: 1 });
    expect(watched.byReason).toEqual({ watched_company_location: 1 });
    expect(await rowsOf(job.id)).toMatchObject([{ filterResult: "passed", filterReasons: ["watched_company_location:Hamburg"] }]);

    await setWatched([]);
    expect(await runStep()).toMatchObject({ updated: 1, filteredOut: 1 });
    expect(await rowsOf(job.id)).toMatchObject([{ filterResult: "filtered_out", filterReasons: ["location_not_allowed:Hamburg"] }]);
  });

  it("the database flag alone watches a company", async () => {
    const job = await addJob({ company: "Flagged Corp", nameNorm: "flagged", watched: true, workplace: "hybrid", locationsJson: hamburgLocation });
    await runStep();
    expect(await rowsOf(job.id)).toMatchObject([{ filterResult: "passed", filterReasons: ["watched_company_location:Hamburg"] }]);
  });

  it("does not keep a place whose country is unknown, nor a place in another country", async () => {
    await setWatched(["Orbitrail", "Globex"]);
    const sf = await addJob({ company: "Orbitrail AG", nameNorm: "orbitrail", workplace: "onsite", locationsJson: [{ label: "San Francisco", city: null, countryCode: null, isPrimary: true }] });
    const london = await addJob({ company: "Globex", nameNorm: "globex", workplace: "onsite", locationsJson: [{ label: "London", city: "London", countryCode: "GB", isPrimary: true }] });
    await runStep();
    expect(await rowsOf(sf.id)).toMatchObject([{ filterResult: "filtered_out", filterReasons: ["location_not_allowed:San Francisco"] }]);
    expect(await rowsOf(london.id)).toMatchObject([{ filterResult: "filtered_out", filterReasons: ["location_not_allowed:London"] }]);
  });

  it("runFilter reads the watch list itself and takes a list passed to it instead", async () => {
    const job = await hamburgJob();
    await setWatched(["Orbitrail"]);
    const db = getDb();
    const current = await currentPreferences(db);
    const base = { preferences: current.preferences, snapshotId: current.snapshot.id, pipeline: shippedPipeline(), me: null };
    await runFilter(db, { ...base, watchedCompanies: [] });
    expect(await rowsOf(job.id)).toMatchObject([{ filterResult: "filtered_out" }]);
    const again = await runFilter(db, base);
    expect(again).toMatchObject({ updated: 1, passed: 1 });
    expect(await rowsOf(job.id)).toMatchObject([{ filterResult: "passed", filterReasons: ["watched_company_location:Hamburg"] }]);
    // the single-job path (the detail page's button) judges alike
    await setWatched([]);
    expect(await refilterJob(getDb(), job.id)).toEqual({ filterResult: "filtered_out", filterReasons: ["location_not_allowed:Hamburg"] });
  });

  it("the push step selects the kept job, and the user's exclude still wins", async () => {
    const job = await hamburgJob();
    await setWatched(["Orbitrail"]);
    await runStep();
    const pipeline = shippedPipeline();
    const select = async () => {
      const candidates = await listPushCandidates(getDb(), { since: new Date(Date.now() - 86_400_000) });
      return selectForPush(candidates, {
        config: { push_min_score: 70, push_min_score_high_value: 60, max_per_cycle: 10 },
        watchedKeys: buildWatchedCompanyKeys(loadConfig("interests").watched_companies, pipeline),
        alreadyNotified: new Set(),
      }).selected.map((item) => item.candidate.jobId);
    };
    expect(await select()).toEqual([job.id]);
    await setFilterOverride(getDb(), job.id, "exclude");
    await runStep();
    expect(await select()).toEqual([]);
  });

  it("an unreadable watch list counts as empty, with a warning; the database flag still works", async () => {
    const flagged = await addJob({ company: "Flagged Corp", nameNorm: "flagged", watched: true, workplace: "onsite", locationsJson: hamburgLocation });
    const listed = await hamburgJob();
    await setWatched(["Orbitrail"]);
    fs.writeFileSync(getConfigPath("interests"), "watched_companies: [unclosed\n");
    resetConfigCache(); // a file edited by hand while no process has it cached
    const warnings: string[] = [];
    const logger = createLogger({ sink: (entry) => void (entry.level === "warn" && warnings.push(entry.message)) });
    expect(currentWatchedCompanies(logger)).toEqual([]);
    expect(warnings).toHaveLength(1);
    const db = getDb();
    const current = await currentPreferences(db);
    await runFilter(db, { preferences: current.preferences, snapshotId: current.snapshot.id, pipeline: shippedPipeline(), me: null, logger });
    expect(await rowsOf(flagged.id)).toMatchObject([{ filterResult: "passed", filterReasons: ["watched_company_location:Hamburg"] }]);
    expect(await rowsOf(listed.id)).toMatchObject([{ filterResult: "filtered_out" }]);
  });

  it("a watch list that turns unreadable while a good one is cached keeps the cached list, with a warning; the database flag still works", async () => {
    const flagged = await addJob({ company: "Flagged Corp", nameNorm: "flagged", watched: true, workplace: "onsite", locationsJson: hamburgLocation });
    const listed = await hamburgJob();
    await setWatched(["Orbitrail"]);
    expect(currentWatchedCompanies()).toEqual(["Orbitrail"]); // cached
    vi.stubEnv("JOB_RADAR_CONFIG_POLL_MS", "1");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fs.writeFileSync(getConfigPath("interests"), "watched_companies: [unclosed\n");
      await new Promise((resolve) => setTimeout(resolve, 20)); // past the poll interval: the next read looks at the file
      const logged: string[] = [];
      const logger = createLogger({ sink: (entry) => void logged.push(entry.message) });
      expect(currentWatchedCompanies(logger)).toEqual(["Orbitrail"]);
      expect(logged).toEqual([]); // loadConfig itself kept the last good value
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/keeping the last valid value/);
      const db = getDb();
      const current = await currentPreferences(db);
      await runFilter(db, { preferences: current.preferences, snapshotId: current.snapshot.id, pipeline: shippedPipeline(), me: null, logger });
      expect(await rowsOf(flagged.id)).toMatchObject([{ filterResult: "passed", filterReasons: ["watched_company_location:Hamburg"] }]);
      expect(await rowsOf(listed.id)).toMatchObject([{ filterResult: "passed", filterReasons: ["watched_company_location:Hamburg"] }]); // still on the cached list
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

describe("in the processing cycle", () => {
  it("runs between pipeline and signals and feeds the dashboard queries", async () => {
    registerBuiltinCycleSteps();
    const visible = await addJob({ title: "Visible AI Engineer" });
    const hidden = await addJob({ title: "Hidden Werkstudent", contract: "student" });
    const result = await runCycle("manual", { registry: new ChannelRegistry(), config: config(), logger: silent, sleep: async () => {} });
    expect(result.summary.steps.map((s) => s.name)).toEqual(["collect", "pipeline", "filter", "signals", "ai", "notify", "maintenance"]);
    expect(result.summary.steps.find((s) => s.name === "filter")).toMatchObject({ status: "ok", result: { evaluated: 2, filteredOut: 1 } });

    const opts = { sort: "first_seen" as const, page: 1, pageSize: 20, timezone: "Europe/Berlin" };
    const defaults = await listJobs(getDb(), { ...opts, filters: {} });
    expect(defaults.jobs.map((j) => j.id)).toEqual([visible.id]);
    const all = await listJobs(getDb(), { ...opts, filters: { includeFiltered: true } });
    expect(all.jobs.map((j) => j.id).sort()).toEqual([visible.id, hidden.id].sort());
    expect(all.jobs.find((j) => j.id === hidden.id)?.rank).toMatchObject({ filterResult: "filtered_out", filterReasons: ["student_role"] });

    const today = { now: new Date(), timezone: "Europe/Berlin" };
    expect((await listTodayJobs(getDb(), today)).map((j) => j.id)).toEqual([visible.id]);
    expect((await listTodayJobs(getDb(), { ...today, includeFiltered: true })).map((j) => j.id)).toEqual([visible.id, hidden.id]);
  });
});

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { loadCompanies } from "@/lib/config";
import {
  closeDb,
  createCycle,
  createRun,
  finishRun,
  getDb,
  getMonthRunTotals,
  getOpenAiRun,
  insertControlRequest,
  claimNextControlRequest,
  finishControlRequest,
  listJobCityRows,
  listJobs,
  schema,
  upsertChannelRows,
} from "@/lib/db";
import { getOrCreateCompany } from "@/lib/db/repos/companies";
import { insertJob } from "@/lib/db/repos/jobs";
import { runMigrations } from "@/lib/db/migrate";
import { buildCityGroups, cityMembers } from "@/lib/jobs/city-groups";
import { syncCompanyDisplayNames } from "@/lib/pipeline/company-names";
import { loadControlStatus } from "@/lib/settings/status";
import { statusNeedsPolling } from "@/lib/settings/status-schema";

import { makeTempConfig, type TempConfig } from "../config/helpers";
import { shippedPipeline } from "../pipeline/helpers";

const url = inject("testDatabaseUrl");
let temp: TempConfig;
const NOW = new Date("2026-10-07T12:00:00Z");
const TZ = "Europe/Berlin";

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

beforeEach(async () => {
  temp?.cleanup();
  temp = makeTempConfig();
  await getDb().execute(sql`truncate table control_requests, runtime_state, runner_heartbeats, scores, translations, jobs, companies, runs, cycles, channels restart identity cascade`);
});

afterAll(async () => {
  temp?.cleanup();
  await closeDb();
});

describe("the AI part of a cycle (getOpenAiRun, control status)", () => {
  it("is null while no run_ai request is open", async () => {
    expect(await getOpenAiRun(getDb())).toBeNull();
    const status = await loadControlStatus(getDb(), NOW);
    expect(status.aiRun).toBeNull();
    expect(statusNeedsPolling(status)).toBe(false);
  });

  it("shows a queued run_ai request with its cycle, and keeps the page polling", async () => {
    const db = getDb();
    const cycle = await createCycle(db, { kind: "manual" });
    const request = await insertControlRequest(db, { kind: "run_ai", payload: { cycleId: cycle.id } });
    const open = await getOpenAiRun(db);
    expect(open).toMatchObject({ requestId: request.id, status: "pending", cycleId: cycle.id, startedAt: null, scored: 0, translated: 0 });

    const status = await loadControlStatus(db, new Date(Date.now() + 90_000));
    expect(status.aiRun).toMatchObject({ requestId: request.id, status: "pending", cycleId: cycle.id, scored: 0, translated: 0 });
    expect(status.aiRun?.elapsedSeconds).toBeGreaterThanOrEqual(89);
    expect(statusNeedsPolling(status)).toBe(true);
    // the settings page lists its own kinds only: the worker's request is not one of the rows
    expect(status.requests.map((r) => r.kind)).not.toContain("run_ai");
  });

  it("counts what the worker has produced since it took the request, then disappears when it is done", async () => {
    const db = getDb();
    const cycle = await createCycle(db, { kind: "manual" });
    const request = await insertControlRequest(db, { kind: "run_ai", payload: { cycleId: cycle.id } });
    await db.update(schema.cycles).set({ status: "succeeded", finishedAt: NOW }).where(eq(schema.cycles.id, cycle.id));
    const claimed = await claimNextControlRequest(db, ["run_ai"]);
    expect(claimed?.id).toBe(request.id);

    const company = await getOrCreateCompany(db, { name: "Acme", nameNorm: "acme" });
    const job = await insertJob(db, { companyId: company.id, title: "AI Engineer", titleNorm: "ai engineer" });
    const other = await insertJob(db, { companyId: company.id, title: "Other", titleNorm: "other" });
    const [snapshot] = await db.insert(schema.profileSnapshots).values({ kind: "preferences", hash: "h", contentYaml: "x" }).returning();
    if (!snapshot) throw new Error("snapshot");
    const old = new Date(Date.now() - 3_600_000);
    await db.insert(schema.scores).values([
      { jobId: job.id, profileSnapshotId: snapshot.id, filterResult: "passed", score: 70, scoredAt: new Date() },
      { jobId: other.id, profileSnapshotId: snapshot.id, filterResult: "passed", score: 50, scoredAt: old },
    ]);
    await db.insert(schema.translations).values({ jobId: job.id, lang: "zh", content: "译文", sourceHash: "x" });

    const running = await getOpenAiRun(db);
    expect(running).toMatchObject({ requestId: request.id, status: "running", scored: 1, translated: 1 });
    expect(running?.startedAt).not.toBeNull();

    await finishControlRequest(db, request.id, { status: "done", result: {} });
    expect(await getOpenAiRun(db)).toBeNull();
    expect((await loadControlStatus(db, NOW)).aiRun).toBeNull();
  });
});

describe("what a channel did this month (getMonthRunTotals)", () => {
  it("sums the runs of the month per channel, in the time zone of the schedule, without skipped ones", async () => {
    const db = getDb();
    await upsertChannelRows(db, [
      { id: "greenhouse", family: "ats", kind: "ats", enabled: true },
      { id: "indeed", family: "indeed", kind: "api", enabled: true },
    ]);
    const cycle = await createCycle(db, { kind: "manual" });
    const make = async (channelId: string, startedAt: Date, input: { status: "succeeded" | "failed" | "skipped"; fetched: number; newCount: number }) => {
      const run = await createRun(db, { channelId, cycleId: cycle.id });
      await db.update(schema.runs).set({ startedAt }).where(eq(schema.runs.id, run.id));
      await finishRun(db, run.id, input);
    };
    await make("greenhouse", new Date("2026-10-02T08:00:00Z"), { status: "succeeded", fetched: 300, newCount: 40 });
    await make("greenhouse", new Date("2026-10-06T08:00:00Z"), { status: "succeeded", fetched: 91, newCount: 2 });
    await make("greenhouse", new Date("2026-10-06T09:00:00Z"), { status: "skipped", fetched: 0, newCount: 0 });
    await make("greenhouse", new Date("2026-09-30T21:59:00Z"), { status: "succeeded", fetched: 999, newCount: 99 }); // 23:59 on 30 Sep in Berlin: last month
    await make("indeed", new Date("2026-09-30T22:30:00Z"), { status: "succeeded", fetched: 5, newCount: 5 }); // 00:30 on 1 Oct in Berlin: this month

    const totals = await getMonthRunTotals(db, { month: "2026-10", timeZone: TZ });
    expect(totals.get("greenhouse")).toEqual({ runs: 2, fetched: 391, newCount: 42 });
    expect(totals.get("indeed")).toEqual({ runs: 1, fetched: 5, newCount: 5 });
    expect(totals.has("lever")).toBe(false);
  });
});

describe("the city dropdown", () => {
  async function seedJobs() {
    const db = getDb();
    const company = await getOrCreateCompany(db, { name: "Acme", nameNorm: "acme" });
    const loc = (label: string, city: string | null, countryCode = "DE") => ({ label, city, countryCode, isPrimary: true });
    const add = async (title: string, locations: unknown[]) => (await insertJob(db, { companyId: company.id, title, titleNorm: title.toLowerCase(), locationsJson: locations })).id;
    return {
      muc: await add("Munich job", [loc("München", "München")]),
      garching: await add("Garching job", [loc("Garching", "Garching")]),
      metro: await add("Metro job", [loc("Greater Munich Metropolitan Area", "Greater Munich Metropolitan Area")]),
      nuremberg: await add("Nuremberg job", [loc("Nürnberg, Mittelfranken", "Nürnberg, Mittelfranken")]),
      hamburg: await add("Hamburg job", [loc("Hamburg", "Hamburg")]),
      none: await add("No place", []),
    };
  }

  it("lists every stored city once per location, and a job with several places once per group", async () => {
    const ids = await seedJobs();
    const rows = await listJobCityRows(getDb());
    expect(rows.map((r) => r.city).sort()).toEqual(["Garching", "Greater Munich Metropolitan Area", "Hamburg", "München", "Nürnberg, Mittelfranken"]);
    expect(rows.find((r) => r.city === "Hamburg")).toMatchObject({ jobId: ids.hamburg, label: "Hamburg", countryCode: "DE" });
    const groups = buildCityGroups(rows, { targets: ["Berlin", "München"], filter: shippedPipeline().filter, market: shippedPipeline().market });
    expect(groups.map((g) => [g.key, g.jobCount])).toEqual([
      ["München", 3],
      ["Hamburg", 1],
      ["Nürnberg", 1],
    ]);
  });

  it("selecting München finds the jobs of its metro area, selecting a plain city finds only its own", async () => {
    const ids = await seedJobs();
    const db = getDb();
    const groups = buildCityGroups(await listJobCityRows(db), { targets: ["Berlin", "München"], filter: shippedPipeline().filter, market: shippedPipeline().market });
    const base = { sort: "first_seen" as const, page: 1, pageSize: 50, timezone: TZ };

    const munich = await listJobs(db, { ...base, filters: { cities: ["München"], cityMembers: cityMembers(groups, "München") } });
    expect(munich.jobs.map((j) => j.id).sort()).toEqual([ids.muc, ids.garching, ids.metro].sort());

    // before: the raw value alone only found the jobs that spell the city exactly
    const exact = await listJobs(db, { ...base, filters: { cities: ["München"] } });
    expect(exact.jobs.map((j) => j.id)).toEqual([ids.muc]);

    const nuremberg = await listJobs(db, { ...base, filters: { cities: ["Nürnberg"], cityMembers: cityMembers(groups, "Nürnberg") } });
    expect(nuremberg.jobs.map((j) => j.id)).toEqual([ids.nuremberg]);
    const hamburg = await listJobs(db, { ...base, filters: { cities: ["Hamburg"], cityMembers: cityMembers(groups, "Hamburg") } });
    expect(hamburg.jobs.map((j) => j.id)).toEqual([ids.hamburg]);
  });
});

describe("company display names", () => {
  const pipeline = shippedPipeline();
  const entries = (...rows: Array<[string, string]>) => rows.map(([name, token]) => ({ name, ats: "greenhouse" as const, token, enabled: true }));

  it("renames a company that was created under its board token, keeping the old spelling as an alias", async () => {
    const db = getDb();
    await getOrCreateCompany(db, { name: "datenhaus", nameNorm: "datenhaus" });
    const result = await syncCompanyDisplayNames(db, { companies: entries(["Datenhaus", "datenhaus"]), pipeline });
    expect(result).toEqual({ renamed: 1, merged: 0 });
    const [row] = await db.select().from(schema.companies);
    expect(row).toMatchObject({ name: "Datenhaus", nameNorm: "datenhaus", aliases: ["datenhaus"] });
  });

  it("re-keys a token company whose proper name is two words ('formgleichlabs' -> 'Formgleich Labs')", async () => {
    const db = getDb();
    const old = await getOrCreateCompany(db, { name: "formgleichlabs", nameNorm: "formgleichlabs" });
    const result = await syncCompanyDisplayNames(db, { companies: entries(["Formgleich Labs", "formgleichlabs"]), pipeline });
    expect(result).toEqual({ renamed: 1, merged: 0 });
    const [row] = await db.select().from(schema.companies);
    expect(row).toMatchObject({ id: old.id, name: "Formgleich Labs", nameNorm: "formgleich-labs" });
  });

  it("folds the token company into the one with the proper name when both exist, moving its jobs", async () => {
    const db = getDb();
    const proper = await getOrCreateCompany(db, { name: "Klingen Health", nameNorm: "klingen-health" });
    const token = await getOrCreateCompany(db, { name: "klingenhealth", nameNorm: "klingenhealth" });
    const job = await insertJob(db, { companyId: token.id, title: "AI Engineer", titleNorm: "ai engineer" });
    const result = await syncCompanyDisplayNames(db, { companies: entries(["Klingen Health", "klingenhealth"]), pipeline });
    expect(result).toEqual({ renamed: 0, merged: 1 });
    expect((await db.select().from(schema.companies)).map((c) => c.name)).toEqual(["Klingen Health"]);
    const [moved] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(moved?.companyId).toBe(proper.id);
  });

  it("leaves a name that came from a posting, and a watched token company, alone", async () => {
    const db = getDb();
    await getOrCreateCompany(db, { name: "Streifen, Inc.", nameNorm: "streifen" });
    const watched = await getOrCreateCompany(db, { name: "trawa", nameNorm: "trawa" });
    await db.update(schema.companies).set({ watched: true }).where(eq(schema.companies.id, watched.id));
    await getOrCreateCompany(db, { name: "Trawa Energy", nameNorm: "trawa-energy" });
    const result = await syncCompanyDisplayNames(db, { companies: entries(["Streifen", "streifen"], ["Trawa Energy", "trawa"]), pipeline });
    expect(result).toEqual({ renamed: 0, merged: 0 });
    expect((await db.select().from(schema.companies)).map((c) => c.name).sort()).toEqual(["Streifen, Inc.", "Trawa Energy", "trawa"]);
  });

  it("getOrCreateCompany upgrades a token spelling to the capitalised one of a later posting, and nothing else", async () => {
    const db = getDb();
    await getOrCreateCompany(db, { name: "zellwerk", nameNorm: "zellwerk" });
    expect((await getOrCreateCompany(db, { name: "Zellwerk", nameNorm: "zellwerk" })).name).toBe("Zellwerk");
    // a proper name stays when a differently spelled one arrives
    expect((await getOrCreateCompany(db, { name: "ZELLWERK", nameNorm: "zellwerk" })).name).toBe("Zellwerk");
    expect(loadCompanies().companies.some((c) => c.token === "zellwerk" && c.name === "Zellwerk")).toBe(true);
  });
});

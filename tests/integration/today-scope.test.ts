import { withRebuiltCurrentScores } from "../helpers/current-scores";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from "vitest";

import { closeDb, countTodayRelisted, getDb, listJobs, getLatestCycleSummary, listTodayJobs, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { countTodayScope } from "@/lib/dashboard/today-scope";

/**
 * The Today list is "this cycle's new jobs and today's". Early in the morning the evening cycle's jobs were first seen
 * yesterday, so a list of the calendar day alone was empty while the KPI strip showed the cycle's hundreds.
 */
const url = inject("testDatabaseUrl");
const TZ = "Europe/Berlin";
// 07:00 in Berlin: today began at 2026-10-06T22:00Z
const NOW = new Date("2026-10-07T05:00:00Z");
const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

beforeEach(async () => {
  await getDb().execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels, applications, runtime_state restart identity cascade`);
});

afterAll(async () => {
  await getDb().execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels, applications restart identity cascade`);
  await closeDb();
});

async function addJobs(firstSeen: Record<string, Date>): Promise<Record<string, number>> {
  const db = getDb();
  const [company] = await db.insert(schema.companies).values({ name: "Scope Co", nameNorm: "scope co" }).returning();
  const ids: Record<string, number> = {};
  for (const [title, firstSeenAt] of Object.entries(firstSeen)) {
    const [job] = await db.insert(schema.jobs).values({ companyId: company!.id, title, titleNorm: title.toLowerCase(), firstSeenAt, lastSeenAt: firstSeenAt }).returning({ id: schema.jobs.id });
    ids[title] = job!.id;
  }
  return ids;
}

async function addCycle(startedAt: Date, finishedAt: Date | null, status: "succeeded" | "running" | "skipped" = "succeeded"): Promise<void> {
  await getDb().insert(schema.cycles).values({ kind: "manual", startedAt, finishedAt, status });
}

const titles = async (cycle: { startedAt: Date; finishedAt: Date | null } | null) => (await listTodayJobs(getDb(), { now: NOW, timezone: TZ, cycle })).map((job) => job.title).sort();

describe("listTodayJobs with the latest cycle", () => {
  it("lists the cycle of yesterday evening when nothing was found yet today", async () => {
    await addJobs({ "Evening A": at("2026-10-06T20:10:00Z"), "Evening B": at("2026-10-06T20:20:00Z"), "Long ago": at("2026-10-05T10:00:00Z") });
    await addCycle(at("2026-10-06T20:00:00Z"), at("2026-10-06T20:30:00Z"));
    const latest = await getLatestCycleSummary(getDb());

    expect(await titles(null)).toEqual([]); // the calendar day alone: the old, empty list
    expect(await titles(latest)).toEqual(["Evening A", "Evening B"]);
    expect(countTodayScope(await listTodayJobs(getDb(), { now: NOW, timezone: TZ, cycle: latest }), { now: NOW, timezone: TZ, cycle: latest })).toEqual({ cycle: 2, today: 0 });
  });

  it("lists the cycle of today (and only the jobs of that cycle from before today)", async () => {
    await addJobs({ "Evening A": at("2026-10-06T20:10:00Z"), "Morning A": at("2026-10-07T04:05:00Z"), "Morning B": at("2026-10-07T04:10:00Z") });
    await addCycle(at("2026-10-06T20:00:00Z"), at("2026-10-06T20:30:00Z"));
    await addCycle(at("2026-10-07T04:00:00Z"), at("2026-10-07T04:30:00Z"));
    const latest = await getLatestCycleSummary(getDb());

    // the evening cycle is no longer the latest one: its job is neither today's nor this cycle's
    expect(await titles(latest)).toEqual(["Morning A", "Morning B"]);
    expect(countTodayScope(await listTodayJobs(getDb(), { now: NOW, timezone: TZ, cycle: latest }), { now: NOW, timezone: TZ, cycle: latest })).toEqual({ cycle: 2, today: 2 });
  });

  it("is the union when the cycle began yesterday and jobs also arrived today outside its window", async () => {
    // the cycle straddles midnight (22:00Z = 00:00 Berlin); one job was first seen in it before midnight, one after, one later and one is old
    await addJobs({
      "Before midnight": at("2026-10-06T21:40:00Z"),
      "After midnight": at("2026-10-06T22:10:00Z"),
      "Today, later": at("2026-10-07T03:00:00Z"),
      "Yesterday, other run": at("2026-10-06T12:00:00Z"),
    });
    await addCycle(at("2026-10-06T21:30:00Z"), at("2026-10-06T22:20:00Z"));
    const latest = await getLatestCycleSummary(getDb());

    expect(await titles(latest)).toEqual(["After midnight", "Before midnight", "Today, later"]);
    const cards = await listTodayJobs(getDb(), { now: NOW, timezone: TZ, cycle: latest });
    expect(countTodayScope(cards, { now: NOW, timezone: TZ, cycle: latest })).toEqual({ cycle: 2, today: 2 });
  });

  it("ignores skipped cycles (they did nothing) and counts a running cycle up to now", async () => {
    await addJobs({ "Evening A": at("2026-10-06T20:10:00Z"), "Running A": at("2026-10-07T04:50:00Z") });
    await addCycle(at("2026-10-06T20:00:00Z"), at("2026-10-06T20:30:00Z"));
    await addCycle(at("2026-10-07T04:55:00Z"), at("2026-10-07T04:55:01Z"), "skipped");
    expect(await titles(await getLatestCycleSummary(getDb()))).toEqual(["Evening A", "Running A"].sort());

    await addCycle(at("2026-10-07T04:40:00Z"), null, "running");
    expect(await titles(await getLatestCycleSummary(getDb()))).toEqual(["Running A"]);
  });

  it("keeps hiding ignored and filtered jobs inside the cycle part", async () => {
    const ids = await addJobs({ Kept: at("2026-10-06T20:10:00Z"), Ignored: at("2026-10-06T20:11:00Z") });
    await getDb().insert(schema.applications).values({ jobId: ids.Ignored!, status: "archived" });
    await addCycle(at("2026-10-06T20:00:00Z"), at("2026-10-06T20:30:00Z"));
    expect(await titles(await getLatestCycleSummary(getDb()))).toEqual(["Kept"]);
  });
});

const highPolicy = { amountId: null, amountHighValue: false, otherIds: ["benefit"], minAnnualEur: null, rates: {}, otherRegionPoints: 0 };

it.each([false, true])("relist count is a subset of the current jobs link with Today toggles (includeFiltered=%s)", async (includeFiltered) => {
  const db = getDb();
  const ids = await addJobs(Object.fromEntries(["Visible", "Filtered", "Ignored", "Manual", "Phrase", "Language", "Low", "Old", "Cycle", "Outside"].map((title) => [title, at("2026-08-01T12:00:00Z")])));
  const latestCycle = { startedAt: at("2026-10-06T20:00:00Z"), finishedAt: at("2026-10-06T20:30:00Z") };
  await db.update(schema.jobs).set({ relistedAt: at("2026-10-07T04:00:00Z"), relistCount: 1 });
  await db.update(schema.jobs).set({ relistedAt: at("2026-10-06T20:15:00Z") }).where(eq(schema.jobs.id, ids.Cycle!));
  await db.update(schema.jobs).set({ relistedAt: at("2026-10-03T12:00:00Z") }).where(eq(schema.jobs.id, ids.Old!));
  await db.update(schema.jobs).set({ relistedAt: at("2026-10-05T20:00:00Z") }).where(eq(schema.jobs.id, ids.Outside!));
  await db.update(schema.jobs).set({ status: "possibly_closed", linkCheckJson: { outcome: "phrase" } }).where(eq(schema.jobs.id, ids.Phrase!));
  await db.update(schema.jobs).set({ germanLevelRequired: "B2" }).where(eq(schema.jobs.id, ids.Language!));
  await db.insert(schema.applications).values({ jobId: ids.Ignored!, status: "archived" });
  await db.insert(schema.jobClosureOverrides).values({ jobId: ids.Manual!, action: "closed" });
  await withRebuiltCurrentScores(db, db.insert(schema.scores).values({ jobId: ids.Filtered!, filterResult: "filtered_out" }));
  for (const [name, id] of Object.entries(ids)) {
    if (name !== "Low") await db.insert(schema.signals).values({ jobId: id, tier: "benefit", kind: "tag", quote: "Support for learning", valueJson: { tag: "learning" }, extractor: "rule" });
  }
  const badgeSince = new Date(NOW.getTime() - 2 * 86_400_000);
  const count = await countTodayRelisted(db, { now: NOW, timezone: TZ, cycle: latestCycle, badgeSince, includeFiltered, hideGermanLevels: ["B2"], highValueOnly: true, highValue: highPolicy });
  const expected = [ids.Visible!, ids.Cycle!, ...(includeFiltered ? [ids.Filtered!] : [])];
  expect(count).toBe(expected.length);
  const linked = await listJobs(db, { filters: { scope: "current", relistedSince: badgeSince, includeFiltered, hideGermanLevels: ["B2"], highValue: highPolicy }, sort: "rank", page: 1, pageSize: 100, timezone: TZ, visa: false });
  const linkedIds = linked.jobs.map((job) => job.id);
  for (const id of expected) expect(linkedIds).toContain(id);
  expect(linkedIds).not.toContain(ids.Manual);
  if (includeFiltered) expect(linkedIds).toContain(ids.Filtered);
});

it("a one-day badge window excludes relists in a latest cycle 37 hours ago", async () => {
  const db = getDb();
  const ids = await addJobs({ Old: at("2026-08-01T12:00:00Z"), Today: at("2026-08-01T12:00:00Z") });
  const cycleAt = new Date(NOW.getTime() - 37 * 3_600_000);
  await db.update(schema.jobs).set({ relistedAt: cycleAt }).where(eq(schema.jobs.id, ids.Old!));
  await db.update(schema.jobs).set({ relistedAt: NOW }).where(eq(schema.jobs.id, ids.Today!));
  expect(await countTodayRelisted(db, { now: NOW, timezone: TZ, cycle: { startedAt: cycleAt, finishedAt: new Date(cycleAt.getTime() + 1000) }, badgeSince: new Date(NOW.getTime() - 86_400_000) })).toBe(1);
});

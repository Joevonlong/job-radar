import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { ensureProfileFiles, reloadConfig, setOnProfileSaved } from "@/lib/config";
import { closeDb, getDb, getViewDailyCounts, listMonthStatedSalaries, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { runFilter } from "@/lib/filter";
import { previewFloor } from "@/lib/profile/floor-preview";

import { makeTempConfig, type TempConfig } from "../config/helpers";
import { shippedPipeline } from "../pipeline/helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const url = inject("testDatabaseUrl");
const TZ = "Europe/Berlin";
const NOW = new Date("2026-10-08T12:00:00Z");
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
  return () => temp.cleanup();
});

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
      title: `AI Engineer ${seq}`,
      titleNorm: `ai engineer ${seq}`,
      locationsJson: [{ label: "Berlin", city: "Berlin", countryCode: "DE", isPrimary: true }],
      workplace: "hybrid",
      contract: "permanent",
      firstSeenAt: new Date("2026-10-05T08:00:00Z"),
      ...over,
    })
    .returning();
  if (!job) throw new Error("job");
  return job;
}

const salary = (min: number | null, max: number | null, quality: "valid" | "review" = "valid", eur = true) => ({
  raw: "x",
  currency: eur ? "EUR" : "USD",
  period: "year",
  min,
  max,
  perYear: { min, max },
  eurPerYear: eur ? { min, max } : null,
  periodAssumed: false,
  origin: "channel",
  qualityStatus: quality,
  reasonCodes: [],
});

describe("floor preview", () => {
  it("lists this month's usable stated salaries, sorted, and leaves out the rest", async () => {
    await addJob({ salaryJson: salary(80_000, 100_000) });
    await addJob({ salaryJson: salary(null, 58_000) });
    await addJob({ salaryJson: salary(90_000, null) });
    await addJob({ salaryJson: salary(70_000, 90_000, "review") }); // flagged implausible
    await addJob({ salaryJson: salary(70_000, 90_000, "valid", false) }); // not convertible to EUR
    await addJob({ salaryJson: salary(70_000, 90_000), firstSeenAt: new Date("2026-09-20T08:00:00Z") }); // last month
    await addJob({ salaryJson: salary(70_000, 90_000), status: "closed" });
    await addJob(); // no salary stated

    const list = await listMonthStatedSalaries(getDb(), { timezone: TZ, now: NOW, currency: "EUR" });
    expect(list).toEqual([
      { min: null, max: 58_000 },
      { min: 90_000, max: null },
      { min: 80_000, max: 100_000 },
    ]);
    // the order is by the figure shown: upper bound, else lower
    expect(list.map((s) => s.max ?? s.min)).toEqual([58_000, 90_000, 100_000]);
  });

  it("counts a job near the turn of the month in the zone's month, not UTC's", async () => {
    // 2026-09-30 22:30 UTC is already October in Berlin (UTC+2)
    await addJob({ salaryJson: salary(60_000, 70_000), firstSeenAt: new Date("2026-09-30T22:30:00Z") });
    expect(await listMonthStatedSalaries(getDb(), { timezone: TZ, now: NOW, currency: "EUR" })).toHaveLength(1);
    expect(await listMonthStatedSalaries(getDb(), { timezone: "UTC", now: NOW, currency: "EUR" })).toHaveLength(0);
  });

  it("the preview count equals what the hard filter really drops at that floor", async () => {
    for (const [min, max] of [[50_000, 60_000], [60_000, 80_000], [80_000, 100_000], [null, 95_000], [90_000, null], [100_000, 140_000]] as const) {
      await addJob({ salaryJson: salary(min, max) });
    }
    await addJob({ salaryJson: salary(10_000, 20_000, "review") }); // never excluded: no basis
    await addJob(); // no salary: kept

    const db = getDb();
    const salaries = await listMonthStatedSalaries(db, { timezone: TZ, now: NOW, currency: "EUR" });
    const preferences = reloadConfig("preferences");
    for (const floor of [0, 55_000, 70_000, 95_000, 110_000, 200_000]) {
      await db.delete(schema.scores);
      const [snapshot] = await db.insert(schema.profileSnapshots).values({ kind: "preferences", hash: `floor-${floor}`, contentYaml: `floor: ${floor}` }).returning();
      await runFilter(db, { preferences: { ...preferences, salary_floor_year: floor }, snapshotId: snapshot?.id ?? 0, pipeline: shippedPipeline(), me: null });
      const dropped = await db.select().from(schema.scores).where(eq(schema.scores.filterResult, "filtered_out"));
      const bySalary = dropped.filter((row) => row.filterReasons.some((reason) => reason.startsWith("salary_below_floor")));
      expect(previewFloor(salaries, floor).filtered, `floor ${floor}`).toBe(bySalary.length);
      expect(previewFloor(salaries, floor).total).toBe(salaries.length);
    }
  });
});

describe("view trends", () => {
  it("counts new jobs per local day for every view in one query, today last", async () => {
    await addJob({ firstSeenAt: new Date("2026-10-08T07:00:00Z") });
    await addJob({ firstSeenAt: new Date("2026-10-08T09:00:00Z"), workplace: "remote" });
    await addJob({ firstSeenAt: new Date("2026-10-06T09:00:00Z") });
    await addJob({ firstSeenAt: new Date("2026-10-06T22:30:00Z") }); // 00:30 on the 7th in Berlin
    await addJob({ firstSeenAt: new Date("2026-09-01T09:00:00Z") }); // outside the window

    const counts = await getViewDailyCounts(getDb(), {
      views: [
        { id: "all", filters: {} },
        { id: "remote", filters: { workplaces: ["remote"] } },
        { id: "munich", filters: { cities: ["München"], cityMembers: ["München"] } },
      ],
      timezone: TZ,
      now: NOW,
      days: 7,
    });
    // 10-02 .. 10-08
    expect(counts.get("all")).toEqual([0, 0, 0, 0, 1, 1, 2]);
    expect(counts.get("remote")).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(counts.get("munich")).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("hides what the hard filter removed unless the view asks for it", async () => {
    const job = await addJob({ firstSeenAt: new Date("2026-10-08T07:00:00Z") });
    await addJob({ firstSeenAt: new Date("2026-10-08T08:00:00Z") });
    await getDb().insert(schema.profileSnapshots).values({ kind: "preferences", hash: "h", contentYaml: "x" });
    const [snapshot] = await getDb().select().from(schema.profileSnapshots);
    await getDb().insert(schema.scores).values({ jobId: job.id, profileSnapshotId: snapshot?.id ?? 0, filterResult: "filtered_out", filterReasons: ["student_role"] });

    const counts = await getViewDailyCounts(getDb(), {
      views: [
        { id: "default", filters: {} },
        { id: "with-filtered", filters: { includeFiltered: true } },
      ],
      timezone: TZ,
      now: NOW,
      days: 3,
    });
    expect(counts.get("default")).toEqual([0, 0, 1]);
    expect(counts.get("with-filtered")).toEqual([0, 0, 2]);
  });

  it("has nothing to count without views", async () => {
    expect((await getViewDailyCounts(getDb(), { views: [], timezone: TZ, now: NOW, days: 7 })).size).toBe(0);
  });
});

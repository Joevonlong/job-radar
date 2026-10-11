import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { closeDb, countTodayJobs, getDb, listJobs, listTodayJobs, type JobFilters, type ListJobsOptions } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { seedDatabase } from "@/lib/db/seed";
import { listJobCityRows } from "@/lib/db";
import { buildCityGroups } from "@/lib/jobs/city-groups";
import { toJobFilters } from "@/lib/jobs/job-filters";
import { shippedPipeline } from "../pipeline/helpers";

const url = inject("testDatabaseUrl");
const TZ = "Europe/Berlin";
const NOW = new Date("2026-10-07T12:00:00Z");

const base = (filters: JobFilters): ListJobsOptions => ({ filters, sort: "first_seen", page: 1, pageSize: 100, timezone: TZ });
const ids = async (filters: JobFilters) =>
  (await listJobs(getDb(), base(filters))).jobs.map((j) => j.id).sort((a, b) => a - b);
const union = (...lists: number[][]) => [...new Set(lists.flat())].sort((a, b) => a - b);
const intersect = (a: number[], b: number[]) => a.filter((id) => b.includes(id));

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

beforeEach(async () => {
  await getDb().execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels, applications, runtime_state restart identity cascade`);
  await seedDatabase(getDb(), { now: NOW, timezone: TZ });
});

afterAll(async () => {
  await getDb().execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels, applications restart identity cascade`);
  await closeDb();
});

describe("multi-value filters", () => {
  it("several cities = the union of the cities, each job once", async () => {
    const berlin = await ids({ cities: ["Berlin"] });
    const munich = await ids({ cities: ["München"] });
    expect(berlin.length).toBeGreaterThan(0);
    expect(munich.length).toBeGreaterThan(0);
    const both = await ids({ cities: ["Berlin", "München"] });
    expect(both).toEqual(union(berlin, munich));
    expect((await listJobs(getDb(), base({ cities: ["Berlin", "München"] }))).total).toBe(both.length);
  });

  it("several sources = a source record of any of the families", async () => {
    const xing = await ids({ sources: ["xing"] });
    const ats = await ids({ sources: ["ats"] });
    expect(xing.length).toBeGreaterThan(0);
    expect(ats.length).toBeGreaterThan(0);
    expect(await ids({ sources: ["xing", "ats"] })).toEqual(union(xing, ats));
  });

  it("several workplaces, contracts and statuses are each an OR", async () => {
    const remote = await ids({ workplaces: ["remote"] });
    const hybrid = await ids({ workplaces: ["hybrid"] });
    expect(await ids({ workplaces: ["remote", "hybrid"] })).toEqual(union(remote, hybrid));
    const permanent = await ids({ contracts: ["permanent"] });
    const freelance = await ids({ contracts: ["freelance"] });
    expect(freelance.length).toBeGreaterThan(0);
    expect(await ids({ contracts: ["permanent", "freelance"] })).toEqual(union(permanent, freelance));
    const active = await ids({ statuses: ["active"] });
    const possiblyClosed = await ids({ statuses: ["possibly_closed"] });
    expect(possiblyClosed.length).toBeGreaterThan(0);
    expect(await ids({ statuses: ["active", "possibly_closed"] })).toEqual(union(active, possiblyClosed));
  });

  it("different filters are an AND: cities x workplaces = the intersection", async () => {
    const cities = await ids({ cities: ["Berlin", "München"] });
    const workplaces = await ids({ workplaces: ["remote", "hybrid"] });
    const both = await ids({ cities: ["Berlin", "München"], workplaces: ["remote", "hybrid"] });
    expect(both).toEqual(intersect(cities, workplaces));
  });

  it("empty lists and null do not filter, and a one-element list equals the old single value", async () => {
    const all = await ids({});
    expect(await ids({ cities: [], sources: [], workplaces: [], contracts: [], statuses: [] })).toEqual(all);
    expect(await ids({ cities: null, sources: null })).toEqual(all);
    const remote = await listJobs(getDb(), base({ workplaces: ["remote"] }));
    expect(remote.jobs.every((j) => j.workplace === "remote")).toBe(true);
  });

  it("a picked city that is a metro area matches all its member spellings, and the union of two groups works", async () => {
    const groups = buildCityGroups(await listJobCityRows(getDb()), { targets: ["Berlin", "München"], filter: shippedPipeline().filter, market: shippedPipeline().market });
    const filtersFor = (cities: string[]) => toJobFilters({ city: cities }, { cityGroups: groups });
    const munich = await ids(filtersFor(["München"]));
    const raw = await ids({ cities: ["München"] });
    expect(munich.length).toBeGreaterThanOrEqual(raw.length);
    const berlin = await ids(filtersFor(["Berlin"]));
    expect(await ids(filtersFor(["München", "Berlin"]))).toEqual(union(munich, berlin));
  });

  it("Today's list and count take the same multi-value filters", async () => {
    const now = NOW;
    const one = await listTodayJobs(getDb(), { now, timezone: TZ, extra: { workplaces: ["remote"] } });
    const two = await listTodayJobs(getDb(), { now, timezone: TZ, extra: { workplaces: ["remote", "hybrid"] } });
    expect(two.length).toBeGreaterThanOrEqual(one.length);
    expect(await countTodayJobs(getDb(), { now, timezone: TZ, extra: { workplaces: ["remote", "hybrid"] } })).toBe(two.length);
    expect(two.every((j) => j.workplace === "remote" || j.workplace === "hybrid")).toBe(true);
  });
});

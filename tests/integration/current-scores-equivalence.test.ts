import { afterAll, beforeAll, expect, inject, it } from "vitest";
import { closeDb, getDb } from "@/lib/db/client";
import { seedDatabase } from "@/lib/db/seed";
import * as live from "@/lib/db/queries/jobs";
import * as old from "./current-scores-baseline/jobs";
import * as today from "@/lib/db/queries/today";
import * as oldToday from "./current-scores-baseline/today";
import { getNavCounts } from "@/lib/db/queries/nav-counts";
import { getNavCounts as oldNav } from "./current-scores-baseline/nav-counts";
import { listCompanyOverview } from "@/lib/db/queries/companies";
import { listCompanyOverview as oldCompanies } from "./current-scores-baseline/companies";
import { listFavoriteJobs } from "@/lib/db/queries/favorites";
import { listFavoriteJobs as oldFavorites } from "./current-scores-baseline/favorites";
import { listPipelineEntries } from "@/lib/db/queries/pipeline";
import { listPipelineEntries as oldPipeline } from "./current-scores-baseline/pipeline";
import { getViewDailyCounts } from "@/lib/db/queries/view-trends";
import { getViewDailyCounts as oldTrends } from "./current-scores-baseline/view-trends";
import { JOB_SORTS } from "@/lib/jobs/constants";
const now = new Date("2026-01-15T12:00:00Z"), timezone = "Europe/Berlin";
beforeAll(() => { process.env.DATABASE_URL = inject("testDatabaseUrl"); }); afterAll(closeDb);
it("matches frozen pre-projection list SQL across every sort, scope and score filter", async () => {
  const db = getDb(); await seedDatabase(db, { now, timezone });
  for (const filters of [{}, { scope: "archive" }, { scope: "all" }, { minRank: 70 }, { includeFiltered: true }, { filteredOnly: true }, { hideGermanLevels: ["c1", "c2", "native"] }] satisfies live.JobFilters[]) {
    for (const sort of JOB_SORTS) {
      const options = { filters, sort, page: 1, pageSize: 50, timezone, visa: false };
      expect(await live.listJobs(db, options)).toEqual(await old.listJobs(db, options));
    }
    expect(await live.countJobList(db, { filters, timezone })).toBe(await old.countJobList(db, { filters, timezone }));
    expect(await live.countJobListSeen(db, { filters, timezone, since: now })).toEqual(await old.countJobListSeen(db, { filters, timezone, since: now }));
    // This is a set for bulk marking, with no SQL ordering contract.
    expect((await live.listUnseenJobIds(db, { filters, timezone })).sort((a, b) => a - b)).toEqual((await old.listUnseenJobIds(db, { filters, timezone })).sort((a, b) => a - b));
  }
});
it("matches navigation, companies, favorites, pipeline, trends and Today", async () => {
  const db = getDb(); await seedDatabase(db, { now, timezone });
  expect(await getNavCounts(db, { now, timezone })).toEqual(await oldNav(db, { now, timezone }));
  expect(await live.listCompanyFilterOptions(db, { limit: 201, timezone })).toEqual(await old.listCompanyFilterOptions(db, { limit: 201, timezone }));
  const companies = { q: "", sort: "score" as const, dir: "desc" as const, page: 1, pageSize: 50, timezone };
  expect(await listCompanyOverview(db, companies)).toEqual(await oldCompanies(db, companies));
  expect(await listFavoriteJobs(db, { sort: "rank" })).toEqual(await oldFavorites(db, { sort: "rank" }));
  expect(await listPipelineEntries(db)).toEqual(await oldPipeline(db));
  const trends = { views: [{ id: "all", filters: {} }], timezone, now, days: 7 };
  expect(await getViewDailyCounts(db, trends)).toEqual(await oldTrends(db, trends));
  const options = { now, timezone, cycle: null };
  expect(await today.listTodayJobs(db, options)).toEqual(await oldToday.listTodayJobs(db, options));
  expect(await today.countTodayJobs(db, options)).toEqual(await oldToday.countTodayJobs(db, options));
  expect(await today.listRecentCycleKpis(db, { limit: 14, qualifiedMinRank: 70 })).toEqual(await oldToday.listRecentCycleKpis(db, { limit: 14, qualifiedMinRank: 70 }));
});

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { checkedUrl, moduleAt } from "./common.mts";
const url = checkedUrl(process.argv[2]), baseline = path.resolve(process.argv[3]!), root = path.resolve(process.argv[4]!), label = process.argv[5]!;
const { createConnection } = await import(moduleAt(root, "src/lib/db/client.ts"));
const connection = createConnection(url.toString(), { sessionSettings: { jit: "off" } }); const { db } = connection;
const now = new Date(), timezone = "Europe/Berlin", window = { from: new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10), to: now.toISOString().slice(0, 10), timezone };
const highValue = { amountId: "T1", amountHighValue: true, otherIds: ["T2"], minAnnualEur: null, rates: {}, otherRegionPoints: 0 };
const passed: string[] = [];
async function compare(file: string, name: string, ...args: unknown[]) {
 const [m, t] = await Promise.all([import(moduleAt(baseline, `src/lib/db/${file}.ts`)), import(moduleAt(root, `src/lib/db/${file}.ts`))]);
 const actual = await t[name](db, ...args), expected = await m[name](db, ...args);
 if(name === "listUnseenJobIds") { actual.sort((a: number, b: number) => a - b); expected.sort((a: number, b: number) => a - b); }
 assert.deepStrictEqual(actual, expected, `${name} ${JSON.stringify(args)}`);
 passed.push(name);
}
try {
 for(const filters of [{}, { scope: "archive" }, { scope: "all" }, { minRank: 70 }, { includeFiltered: true }, { filteredOnly: true }, { hideGermanLevels: ["c1", "c2", "native"] }]) {
  for(const sort of ["relevance", "rank", "posted", "first_seen", "salary", "last_listed"]) await compare("queries/jobs", "listJobs", { filters, sort, page: 1, pageSize: 50, timezone });
  await compare("queries/jobs", "countJobList", { filters, timezone });
  await compare("queries/jobs", "countJobListSeen", { filters, timezone, since: now });
  await compare("queries/jobs", "listUnseenJobIds", { filters, timezone });
 }
 await compare("queries/jobs", "listCompanyFilterOptions", { limit: 201, timezone });
 await compare("queries/jobs", "listJobCountryOptions", { timezone });
 await compare("queries/nav-counts", "getNavCounts", { now, timezone });
 await compare("queries/companies", "listCompanyOverview", { q: "", sort: "score", dir: "desc", page: 1, pageSize: 50, timezone });
 await compare("queries/favorites", "listFavoriteJobs", { sort: "rank" });
 await compare("queries/pipeline", "listPipelineEntries");
 await compare("queries/view-trends", "getViewDailyCounts", { views: [{ id: "all", filters: {} }], now, timezone, days: 14 });
 for(const name of ["listTodayJobs", "countTodayJobs"]) await compare("queries/today", name, { now, timezone, cycle: null });
 await compare("queries/today", "countTodayQuickViews", { now, timezone, cycle: null, quickLines: { qualifiedMinRank: 70 } });
 await compare("queries/today", "listRecentCycleKpis", { limit: 14, qualifiedMinRank: 70 });
 const { getLatestCycleSummary } = await import(moduleAt(root, "src/lib/db/queries/today.ts")); const cycle = await getLatestCycleSummary(db, { qualifiedMinRank: 70 });
 await compare("queries/today", "listCycleNewJobs", cycle, 20);
 await compare("queries/today", "listTodayCycleSummaries", { now, timezone, qualifiedMinRank: 70 });
 for(const name of ["getDailyCounts", "countPassedFirstSeen", "getSourceCounts", "getFunnelStats"]) await compare("repos/insights", name, window);
 await compare("repos/insights", "getCityCounts", window, ["Berlin"]);
 await compare("repos/insights", "getSalaryStats", window, 10000, 20, 3, "EUR");
 await compare("repos/insights", "getSignalStats", window, highValue, []);
 await compare("repos/insights", "getScoreStats", window, 10, 12, 70);
 await compare("repos/insights", "getFilterStats", window, 10);
 const result = { label, count: passed.length, passed };
 await fs.writeFile(`/tmp/current-scores-equivalence-${label}.json`, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await connection.sql.end(); }

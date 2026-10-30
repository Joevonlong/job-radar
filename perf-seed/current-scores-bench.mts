import path from "node:path";
import fs from "node:fs/promises";
import { checkedUrl, measure, moduleAt } from "./common.mts";
const url = checkedUrl(process.argv[2]), root = path.resolve(process.argv[3]!), label = process.argv[4]!;
const { createConnection } = await import(moduleAt(root, "src/lib/db/client.ts"));
const job = await import(moduleAt(root, "src/lib/db/queries/jobs.ts"));
const today = await import(moduleAt(root, "src/lib/db/queries/today.ts"));
const { getNavCounts } = await import(moduleAt(root, "src/lib/db/queries/nav-counts.ts"));
const { listCompanyOverview } = await import(moduleAt(root, "src/lib/db/queries/companies.ts"));
const { listFavoriteJobs } = await import(moduleAt(root, "src/lib/db/queries/favorites.ts"));
const { listPipelineEntries } = await import(moduleAt(root, "src/lib/db/queries/pipeline.ts"));
const { getViewDailyCounts } = await import(moduleAt(root, "src/lib/db/queries/view-trends.ts"));
const insight = await import(moduleAt(root, "src/lib/db/repos/insights.ts"));
const { sql } = createConnection(url.toString(), { sessionSettings: { jit: "off" } });
const { drizzle } = await import("drizzle-orm/postgres-js");
const schema = await import(moduleAt(root, "src/lib/db/schema.ts"));
let capture = false;
const captured: { sql: string; params: unknown[] }[] = [];
const db = drizzle(sql, { schema, logger: { logQuery(query: string, params: unknown[]) { if(capture) captured.push({ sql: query, params }); } } });
const timezone = "Europe/Berlin", now = new Date(), window = { from: new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10), to: now.toISOString().slice(0, 10), timezone };
const work: Record<string, () => Promise<unknown>> = {
 listJobs: () => job.listJobs(db, { filters: {}, sort: "rank", page: 1, pageSize: 50, timezone }),
 countCurrent: () => job.countJobList(db, { filters: {}, timezone }),
 countArchive: () => job.countJobList(db, { filters: { scope: "archive" }, timezone }),
 seen: () => job.countJobListSeen(db, { filters: {}, timezone, since: new Date(now.getTime() - 86400000) }),
 unseen: () => job.listUnseenJobIds(db, { filters: {}, timezone }),
 companies: () => job.listCompanyFilterOptions(db, { limit: 201, timezone }),
 nav: () => getNavCounts(db, { now, timezone }),
 companyOverview: () => listCompanyOverview(db, { q: "", sort: "score", dir: "desc", page: 1, pageSize: 50, timezone }),
 favorites: () => listFavoriteJobs(db, { sort: "rank" }), pipeline: () => listPipelineEntries(db),
 trends: () => getViewDailyCounts(db, { views: [{ id: "all", filters: {} }], now, timezone, days: 14 }),
 today: () => today.listTodayJobs(db, { now, timezone, cycle: null }),
 todayCount: () => today.countTodayJobs(db, { now, timezone, cycle: null }),
 quick: () => today.countTodayQuickViews(db, { now, timezone, cycle: null, quickLines: { qualifiedMinRank: 70 } }),
 kpis: () => today.listRecentCycleKpis(db, { limit: 14, qualifiedMinRank: 70 }),
 cycleSummaries: () => today.listTodayCycleSummaries(db, { now, timezone, qualifiedMinRank: 70 }),
 daily: () => insight.getDailyCounts(db, window), passed: () => insight.countPassedFirstSeen(db, window),
 sources: () => insight.getSourceCounts(db, window), cities: () => insight.getCityCounts(db, window, ["Berlin"]),
 salary: () => insight.getSalaryStats(db, window, 10000, 20, 3, "EUR"),
 signals: () => insight.getSignalStats(db, window, { amountId: "T1", amountHighValue: true, otherIds: ["T2"], minAnnualEur: null, rates: {}, otherRegionPoints: 0 }, []),
 scores: () => insight.getScoreStats(db, window, 10, 12, 70), funnel: () => insight.getFunnelStats(db, window),
 filters: () => insight.getFilterStats(db, window, 10),
};
try {
 const results: Record<string, unknown> = {};
 results.environment = await sql`select current_setting('server_version') as server_version, current_setting('shared_buffers') as shared_buffers, current_setting('work_mem') as work_mem, current_setting('jit') as jit, current_setting('max_connections') as max_connections, current_setting('max_locks_per_transaction') as max_locks_per_transaction`;
 results.counts = await sql`select count(*)::int as jobs, count(*) filter(where dormant_at is not null)::int as dormant, count(*) filter(where status <> 'closed' and dormant_at is null)::int as hot, (select count(*)::int from scores) as scores from jobs`;
 const plans: Record<string, unknown> = {};
 const before = await sql`select temp_bytes from pg_stat_database where datname = current_database()`;
 for (const [name, fn] of Object.entries(work)) { results[name] = await measure(fn); console.log(JSON.stringify({ label, name, result: results[name] }));
   capture = true; await fn(); capture = false;
   plans[name] = [];
   for(const query of captured.splice(0)) if(/^\s*(select|with)\b/i.test(query.sql)) (plans[name] as unknown[]).push(await sql.unsafe(`explain (analyze, buffers, format json) ${query.sql}`, query.params)); }
 if (label.includes("projection")) {
   const { checkCurrentScores, currentScoreRule } = await import(moduleAt(root, "src/lib/db/repos/current-scores.ts"));
   results.check = await measure(() => checkCurrentScores(db));
   for(const size of [3, 200, 10000]) for(const lateral of [false, true]) {
     const ids = Array.from({ length: size }, (_, i) => i + 1);
     const query = currentScoreRule(db, ids, lateral).toSQL();
     const plan = await sql.unsafe(`explain (analyze, buffers, format json) ${query.sql}`, query.params);
     await fs.writeFile(`/tmp/current-scores-plan-${label}-${size}-${lateral}.json`, JSON.stringify(plan));
   }
 }
 results.tempBytes = Number((await sql`select temp_bytes from pg_stat_database where datname = current_database()`)[0].temp_bytes) - Number(before[0].temp_bytes);
 await fs.writeFile(`/tmp/current-scores-read-plans-${label}.json`, JSON.stringify(plans));
 await fs.writeFile(`/tmp/current-scores-bench-${label}.json`, JSON.stringify(results, null, 2));
} finally { await sql.end(); }

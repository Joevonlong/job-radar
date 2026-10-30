import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import postgres from "postgres";
import { checkedDatabase, checkedUrl, moduleAt, stats } from "./common.mts";
const url = checkedUrl(process.argv[2]), template = checkedDatabase(process.argv[3]!), root = path.resolve(process.argv[4]!), label = process.argv[5]!;
const projection = label.includes("projection");
const only = z.literal("save").optional().parse(process.argv[6]);
const { createConnection } = await import(moduleAt(root, "src/lib/db/client.ts"));
const scores = await import(moduleAt(root, "src/lib/db/repos/scores.ts"));
const filter = await import(moduleAt(root, "src/lib/db/repos/filter-results.ts"));
const signals = await import(moduleAt(root, "src/lib/db/repos/signals.ts"));
const current = projection ? await import(moduleAt(root, "src/lib/db/repos/current-scores.ts")) : null;
const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
const result: Record<string, unknown> = only ? JSON.parse(await fs.readFile(`/tmp/current-scores-writes-${label}.json`, "utf8")) : {};
for (const scenario of (only ? [only] : ["save", "filter", "stale", "bonus", "ten_thousand", ...(projection ? ["all_buckets"] : [])])) {
 const name = checkedDatabase(`${template}_${label.replace(/[^a-z0-9]/g, "_")}_${scenario}`);
 let connection;
 try {
  await admin.unsafe(`create database "${name}" template "${template}"`);
  const target = new URL(url); target.pathname = `/${name}`;
  connection = createConnection(target.toString(), { max: 5, sessionSettings: { application_name: `scoreperf_${scenario}`, session_preload_libraries: "auto_explain", "auto_explain.log_min_duration": "0", "auto_explain.log_analyze": "on", "auto_explain.log_buffers": "on", "auto_explain.log_format": "json", log_lock_waits: "on", deadlock_timeout: "10ms" } });
  const { db, sql } = connection;
  const [row] = await sql`select * from scores where score is not null and filter_result = 'passed' and profile_snapshot_id is not null order by created_at desc, id desc limit 1`;
  const input = { rowId: Number(row.id), jobId: Number(row.job_id), profileSnapshotId: Number(row.profile_snapshot_id), provider: "fixture", model: "fixture", score: 70, aiScore: 70, germanPenalty: 0, germanLevel: "unknown", germanLevelAi: "unknown", germanLevelSource: "agree", signalBonus: 0, rankValue: 70, fitReasons: [], gaps: [], summaries: { en: "Performance fixture" }, outputLang: "en", promptVersion: "perf" };
  const run = async (fn: (tx: unknown) => Promise<unknown>) => current ? current.scoreTransaction(db, fn) : fn(db);
  let saveNumber = 0;
  const save = () => {
    const value = 70 + (saveNumber++ % 2);
    return run((tx) => scores.saveScore(tx, { ...input, score: value, aiScore: value, rankValue: value, summaries: { en: `Performance fixture ${saveNumber}` } }));
  };
  const times: number[] = [], batches = [];
  const before = await sql`select temp_bytes from pg_stat_database where datname = current_database()`;
  for (let batch = 0; batch < 5; batch++) {
   let work: () => Promise<unknown>;
   if (scenario === "save") work = save;
   else if (scenario === "filter") {
    const [snap] = await sql`insert into profile_snapshots (kind, hash, content_yaml) values ('preferences', ${`perf_${batch}`}, 'fixture') returning id`;
    const jobs = await sql`select id from jobs where status <> 'closed' and dormant_at is null`;
    const rows = jobs.map((job) => ({ jobId: Number(job.id), filterResult: "passed", filterReasons: [] }));
    work = () => run((tx) => filter.insertFilterResults(tx, Number(snap.id), rows));
   } else if (scenario === "stale" || scenario === "all_buckets") {
    await sql`update scores set stale = false where score is not null`;
    if(current) await current.rebuildCurrentScores(db, { batchJobs: 10000 });
    work = () => run((tx) => scores.markScoresStaleExcept(tx, Number(row.profile_snapshot_id)));
   } else if (scenario === "bonus") {
    const rows = await sql`select id, score from scores`;
    const updates = rows.map((row) => ({ scoreId: Number(row.id), signalBonus: batch + 1, rankValue: row.score === null ? null : Number(row.score) + batch + 1 }));
    work = () => run((tx) => signals.setScoreBonuses(tx, updates));
   } else {
    const rows = await sql`select distinct job_id from scores order by job_id limit 10000`;
    const ids = rows.map((row) => Number(row.job_id));
    work = () => run(async (tx: typeof db) => {
      const { sql: querySql } = await import("drizzle-orm");
      await tx.execute(querySql`update scores set stale = ${batch % 2 === 0} where job_id = any(${`{${ids.join(",")}}`}::bigint[])`);
      if (current) tx.touch(ids);
    });
   }
   if (scenario === "all_buckets") {
    const single: number[] = [], waits: unknown[] = []; let done = false, phaseAt = 0;
    let ready!: () => void, release!: () => void;
    const written = new Promise<void>((resolve) => { ready = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const [coverage] = await sql`select count(distinct job_id % 256)::int as buckets from scores where score is not null and profile_snapshot_id <> ${Number(row.profile_snapshot_id)}`;
    const start = performance.now();
    const large = current!.scoreTransaction(db, async (tx: typeof db) => {
      await scores.markScoresStaleExcept(tx, Number(row.profile_snapshot_id));
      phaseAt = performance.now(); ready(); await gate;
    }).finally(() => { done = true; });
    await written;
    const sample = (async () => { while (!done) { waits.push(...await admin`select wait_event_type, wait_event from pg_stat_activity where datname = ${name} and application_name = 'scoreperf_all_buckets'`); await new Promise((r) => setTimeout(r, 2)); } })();
    release();
    while (!done && performance.now() - phaseAt < 10000) { const at = performance.now(); await save(); single.push(performance.now() - at); }
    await large; const finished = performance.now(); await sample;
    batches.push({ totalMs: finished - start, refreshMs: finished - phaseAt, buckets: Number(coverage.buckets), single: stats(single), waits });
   } else {
    const samples = [];
    for(let n = 0; n < (scenario === "save" ? 20 : 1); n++) { const at = performance.now(); await work(); samples.push(performance.now() - at); }
    times.push(...samples); batches.push(stats(samples));
   }
  }
  const after = await sql`select temp_bytes from pg_stat_database where datname = current_database()`;
  result[scenario] = { batches, overall: times.length ? stats(times) : null, tempBytes: Number(after[0].temp_bytes) - Number(before[0].temp_bytes) };
  console.log(JSON.stringify({ label, scenario, result: result[scenario] }));
 } finally { await connection?.sql.end(); await admin.unsafe(`drop database if exists "${name}" with (force)`); }
}
await admin.end(); await fs.writeFile(`/tmp/current-scores-writes-${label}.json`, JSON.stringify(result, null, 2));

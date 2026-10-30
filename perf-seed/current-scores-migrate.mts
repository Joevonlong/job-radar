import path from "node:path";
import fs from "node:fs/promises";
import postgres from "postgres";
import { outputArgs, checkedDatabase, checkedUrl, moduleAt, stats } from "./common.mts";
const { out, args } = outputArgs(process.argv.slice(2));
const adminUrl = checkedUrl(args[0]), template = checkedDatabase(args[1]!), root = path.resolve(args[2]!), label = args[3]!;
const name = checkedDatabase(`${template}_migration`), admin = postgres(adminUrl.toString(), { max: 2, onnotice: () => {} });
const { createConnection } = await import(moduleAt(root, "src/lib/db/client.ts"));
const { saveScore } = await import(moduleAt(root, "src/lib/db/repos/scores.ts"));
const { insertFilterResults } = await import(moduleAt(root, "src/lib/db/repos/filter-results.ts"));
const { scoreTransaction } = await import(moduleAt(root, "src/lib/db/repos/current-scores.ts"));
const { runMigrations } = await import(moduleAt(root, "src/lib/db/migrate.ts"));
const { currentScoresBackfill } = await import(moduleAt(root, "src/lib/db/current-scores-config.ts"));
let connection;
try {
 await admin.unsafe(`create database "${name}" template "${template}"`);
 for(const [setting, value] of Object.entries({ session_preload_libraries: "auto_explain", "auto_explain.log_min_duration": "0", "auto_explain.log_analyze": "on", "auto_explain.log_buffers": "on", "auto_explain.log_format": "json", log_min_duration_statement: "0", log_lock_waits: "on", deadlock_timeout: "10ms" })) await admin.unsafe(`alter database "${name}" set ${setting} = '${value}'`);
 const target = new URL(adminUrl); target.pathname = `/${name}`; connection = createConnection(target.toString(), { max: 3, sessionSettings: { application_name: "scoreperf_migration_writer" } });
 const { db, sql } = connection;
 const [row] = await sql`select * from scores where score is not null and profile_snapshot_id is not null order by created_at desc limit 1`;
 const input = { rowId: Number(row.id), jobId: Number(row.job_id), profileSnapshotId: Number(row.profile_snapshot_id), provider: "fixture", model: "fixture", score: 70, aiScore: 70, germanPenalty: 0, germanLevel: "unknown", germanLevelAi: "unknown", germanLevelSource: "agree", signalBonus: 0, rankValue: 70, fitReasons: [], gaps: [], summaries: { en: "Performance fixture" }, outputLang: "en", promptVersion: "perf" };
 const [snap] = await sql`insert into profile_snapshots (kind, hash, content_yaml) values ('preferences', 'perf_migration', 'fixture') returning id`;
 const jobs = await sql`select id from jobs where status <> 'closed' and dormant_at is null`;
 const writes: number[] = [], waits: unknown[] = []; let done = false;
 const writer = (async () => { for(let i = 0; !done && i < 500; i++) { const start = performance.now(); await scoreTransaction(db, (tx) => saveScore(tx, input)); writes.push(performance.now() - start); await new Promise((r) => setTimeout(r, 2)); } })();
 const bulkStart = performance.now();
 const bulk = scoreTransaction(db, (tx) => insertFilterResults(tx, Number(snap.id), jobs.map((job) => ({ jobId: Number(job.id), filterResult: "passed", filterReasons: [] })))).then(() => performance.now() - bulkStart);
 const sampler = (async () => { while(!done) { waits.push(...await admin`select query, wait_event_type, wait_event from pg_stat_activity where datname = ${name} and state = 'active'`); await new Promise((r) => setTimeout(r, 5)); } })();
 const start = performance.now();
 try { await runMigrations({ url: target.toString(), migrationsFolder: path.join(root, "drizzle"), currentScoresBackfill: currentScoresBackfill() }); }
 finally { done = true; }
 const migrationMs = performance.now() - start; await writer; const batchWriteMs = await bulk; await sampler;
 const result = { migrationMs, batchWriteMs, writes: stats(writes), waitSamples: waits };
 await fs.writeFile(path.join(out, `current-scores-migrate-${label}.json`), JSON.stringify(result, null, 2));
 console.log(JSON.stringify({ label, migrationMs, batchWriteMs, writes: stats(writes) }));
} finally { await connection?.sql.end(); await admin.unsafe(`drop database if exists "${name}" with (force)`); await admin.end(); }

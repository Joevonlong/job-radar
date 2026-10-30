import path from "node:path";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import { checkedDatabase, checkedUrl, moduleAt } from "./common.mts";
const url = checkedUrl(process.argv[2]), baseline = path.resolve(process.argv[3]!), root = path.resolve(process.argv[4]!), container = process.argv[5]!;
if (!/^[a-zA-Z0-9_-]+$/.test(container)) throw new Error("Explicit disposable container name is required");
const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
const exists = async (name: string) => (await admin`select 1 from pg_database where datname = ${name}`).length > 0;
const run = (file: string, ...args: string[]) => execFileSync(process.execPath, ["--import", "tsx", path.resolve(root, "perf-seed", file), ...args], { cwd: root, stdio: "inherit", env: process.env });
try {
 const { runMigrations } = await import(moduleAt(root, "src/lib/db/migrate.ts"));
 const { currentScoresBackfill } = await import(moduleAt(root, "src/lib/db/current-scores-config.ts"));
 for(const [scale, count, span] of [["year", 40000, 410], ["today", 3000, 45]] as const) {
  const name = checkedDatabase(`jobradar_test_scoreperf_${scale}`), base = checkedDatabase(`${name}_base`);
  if(!(await exists(name))) run("prepare.mts", url.toString(), name, baseline, String(count), String(span), container);
  if(!(await exists(base))) await admin.unsafe(`create database "${base}" template "${name}"`);
  const target = new URL(url); target.pathname = `/${name}`;
  await runMigrations({ url: target.toString(), migrationsFolder: path.join(root, "drizzle"), currentScoresBackfill: currentScoresBackfill() });
  const session = postgres(target.toString(), { max: 1 });
  try { await session`vacuum analyze job_current_scores`; } finally { await session.end(); }
  run("equivalence.mts", target.toString(), baseline, root, scale);
  run("current-scores-bench.mts", target.toString(), baseline, `${scale}_baseline`);
  run("current-scores-bench.mts", target.toString(), root, `${scale}_projection`);
  run("current-scores-writes.mts", url.toString(), base, baseline, `${scale}_baseline`);
  run("current-scores-writes.mts", url.toString(), name, root, `${scale}_projection`);
  run("current-scores-migrate.mts", url.toString(), base, root, scale);
 }
} finally { await admin.end(); }

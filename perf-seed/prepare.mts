import { currentScoresBackfill } from "../src/lib/db/current-scores-config";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import { checkedDatabase, checkedUrl, moduleAt } from "./common.mts";
import { jobLocations } from "./locations.mts";
const adminUrl = checkedUrl(process.argv[2]), name = checkedDatabase(process.argv[3]!);
const root = path.resolve(process.argv[4]!), count = Number(process.argv[5] ?? 40000), span = Number(process.argv[6] ?? 410);
if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(span) || span < 1) throw new Error("Invalid seed size");
const admin = postgres(adminUrl.toString(), { max: 1 });
try {
  await admin.unsafe(`drop database if exists "${name}" with (force)`); await admin.unsafe(`create database "${name}"`);
  const target = new URL(adminUrl); target.pathname = `/${name}`;
  const { runMigrations } = await import(moduleAt(root, "src/lib/db/migrate.ts"));
  await runMigrations({ url: target.toString(), migrationsFolder: path.join(root, "drizzle"), currentScoresBackfill: currentScoresBackfill() });
  const container = process.argv[7];
  if (!container || !/^[a-zA-Z0-9_-]+$/.test(container)) throw new Error("Explicit disposable container name is required");
  const locations = Array.from({ length: 120000 }, (_, i) => `${i + 1}\t${JSON.stringify(jobLocations()).replace(/\\/g, "\\\\")}`).join("\n");
  const seed = (await fs.readFile(new URL("seed.sql", import.meta.url), "utf8")).replace("\\copy locpool from pstdin", `copy locpool from stdin;\n${locations}\n\\.\n`);
  const psql = (input: string, vars: string[] = []) => execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", name, "-v", "ON_ERROR_STOP=1", ...vars], { input, stdio: ["pipe", "inherit", "inherit"] });
  psql(seed, ["-v", `njobs=${count}`, "-v", `span=${span}`, "-v", "snapgap=45", "-v", "pclosed=0.25"]);
  psql(await fs.readFile(new URL("windows.sql", import.meta.url), "utf8"));
  const { createConnection } = await import(moduleAt(root, "src/lib/db/client.ts"));
  const { loadPipeline } = await import(moduleAt(root, "src/lib/market/index.ts"));
  const { markJobsDormant } = await import(moduleAt(root, "src/lib/db/repos/dormancy.ts"));
  const connection = createConnection(target.toString());
  try {
    const lifecycle = loadPipeline().lifecycle;
    if (markJobsDormant) await markJobsDormant(connection.db, { now: new Date(), possiblyClosedAfterDays: lifecycle.possibly_closed_after_days, dormantAfterDays: lifecycle.dormant_after_days });
  } finally { await connection.sql.end(); }
} finally { await admin.end(); }

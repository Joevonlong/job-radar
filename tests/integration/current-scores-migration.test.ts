import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { listJobs } from "@/lib/db/queries/jobs";
import fs from "node:fs/promises";
import { sql } from "drizzle-orm";
import { expect, inject, it } from "vitest";
import { createConnection } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { currentScoresTableExists, invalidateCurrentScores, repairCurrentScores, scoreTransaction } from "@/lib/db/repos/current-scores";
import { currentScore, withCurrentScore } from "@/lib/db/queries/job-cards";
import { createIsolatedDb } from "../helpers/isolated-db";
import { barrier, expectNoDrift, fixture, scoreRow, scores } from "./current-scores-support";
const backfill = { lockTimeoutMs: 100, statementTimeoutMs: 60000 };
async function beforeProjection() {
  const isolated = await createIsolatedDb(inject("testDatabaseUrl"), "projection");
  const connection = createConnection(isolated.url, { max: 3 });
  await connection.sql`drop function job_current_scores_lock(bigint[])`;
  await connection.sql`drop table job_current_scores`;
  await connection.sql`delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)`;
  return { ...connection, url: isolated.url, async close() { await connection.sql.end(); await isolated.drop(); } };
}
it("backfills existing rows, restores timeouts, and changes fallback to projection without restart", async () => {
  const c = await beforeProjection();
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "projection-migration-"));
  try {
    const [job] = await fixture(c.db);
    await scoreTransaction(c.db, async (tx) => { await tx.insert(scores).values(scoreRow(job!.id)); tx.touch([job!.id]); });
    expect(await currentScoresTableExists(c.db)).toBe(false);
    let source = await currentScore(c.db, "set"); expect(withCurrentScore(c.db, source).select().from(source).toSQL().sql).toContain("distinct on");
    const before = await listJobs(c.db, { filters: {}, sort: "rank", page: 1, pageSize: 10, timezone: "UTC" });
    await fs.cp("drizzle", folder, { recursive: true });
    const journalPath = path.join(folder, "meta/_journal.json");
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8")) as { entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[] };
    const last = journal.entries.at(-1)!;
    const probeTag = `${String(last.idx + 1).padStart(4, "0")}_timeout_probe`;
    journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag: probeTag });
    await fs.writeFile(journalPath, JSON.stringify(journal));
    await fs.writeFile(path.join(folder, `${probeTag}.sql`), "create table migration_timeout_probe as select current_setting('lock_timeout') as lock_timeout, current_setting('statement_timeout') as statement_timeout;");
    await runMigrations({ url: c.url, migrationsFolder: folder, currentScoresBackfill: backfill });
    source = await currentScore(c.db, "set"); expect(withCurrentScore(c.db, source).select().from(source).toSQL().sql).not.toContain("distinct on");
    await expectNoDrift(c.db);
    expect((await c.sql`select * from migration_timeout_probe`)[0]).toMatchObject({ lock_timeout: "0", statement_timeout: "0" });
    expect(await listJobs(c.db, { filters: {}, sort: "rank", page: 1, pageSize: 10, timezone: "UTC" })).toEqual(before);
    await c.sql`drop table job_current_scores`;
    expect(await listJobs(c.db, { filters: {}, sort: "rank", page: 1, pageSize: 10, timezone: "UTC" })).toEqual(before);
  } finally { await c.close(); await fs.rm(folder, { recursive: true, force: true }); }
});
it("rolls back the complete migration on lock timeout, then succeeds on retry", async () => {
  const c = await beforeProjection(); const entered = barrier(), release = barrier(); let writer: Promise<unknown> | undefined;
  try {
    const [job] = await fixture(c.db);
    writer = c.db.transaction(async (tx) => { await tx.insert(scores).values(scoreRow(job!.id)); entered.release(); await release.promise; });
    await entered.promise;
    await expect(runMigrations({ url: c.url, currentScoresBackfill: backfill })).rejects.toThrow();
    invalidateCurrentScores(c.db); expect(await currentScoresTableExists(c.db)).toBe(false);
    release.release(); await writer;
    await runMigrations({ url: c.url, currentScoresBackfill: backfill }); await expectNoDrift(c.db);
  } finally { release.release(); await writer; await c.close(); }
});
it("refuses a raw migration without timeout GUCs and rolls back DDL", async () => {
  const c = await beforeProjection();
  try {
    const file = (await fs.readdir("drizzle")).find((name) => name.endsWith("_job_current_scores.sql"));
    if (!file) throw new Error("Current score migration is missing");
    const migration = await fs.readFile(path.join("drizzle", file), "utf8");
    await expect(c.db.transaction(async (tx) => { for (const statement of migration.split("--> statement-breakpoint")) await tx.execute(sql.raw(statement)); })).rejects.toThrow();
    expect(await currentScoresTableExists(c.db)).toBe(false);
    await repairCurrentScores(c.db, []);
  } finally { await c.close(); }
});

it("the direct migration command applies configured limits to its explicit test database", async () => {
  const c = await beforeProjection();
  try {
    const refused = spawnSync(process.execPath, ["--import", "tsx", "scripts/db-migrate.ts", "--config", "unexpected"], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: c.url }, encoding: "utf8", timeout: 60000,
    });
    expect(refused.status).not.toBe(0);
    expect(await currentScoresTableExists(c.db)).toBe(false);
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/db-migrate.ts"], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: c.url }, encoding: "utf8", timeout: 60000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(await currentScoresTableExists(c.db)).toBe(true);
    await expectNoDrift(c.db);
  } finally { await c.close(); }
});

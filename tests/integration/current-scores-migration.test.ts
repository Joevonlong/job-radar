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
    journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag: "0045_timeout_probe" });
    await fs.writeFile(journalPath, JSON.stringify(journal));
    await fs.writeFile(path.join(folder, "0045_timeout_probe.sql"), "create table migration_timeout_probe as select current_setting('lock_timeout') as lock_timeout, current_setting('statement_timeout') as statement_timeout;");
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
    const migration = await fs.readFile("drizzle/0044_job_current_scores.sql", "utf8");
    await expect(c.db.transaction(async (tx) => { for (const statement of migration.split("--> statement-breakpoint")) await tx.execute(sql.raw(statement)); })).rejects.toThrow();
    expect(await currentScoresTableExists(c.db)).toBe(false);
    await repairCurrentScores(c.db, []);
  } finally { await c.close(); }
});

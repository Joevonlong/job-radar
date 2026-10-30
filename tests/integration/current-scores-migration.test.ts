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
  try {
    const [job] = await fixture(c.db);
    await scoreTransaction(c.db, async (tx) => { await tx.insert(scores).values(scoreRow(job!.id)); tx.touch([job!.id]); });
    expect(await currentScoresTableExists(c.db)).toBe(false);
    let source = await currentScore(c.db, "set"); expect(withCurrentScore(c.db, source).select().from(source).toSQL().sql).toContain("distinct on");
    await runMigrations({ url: c.url, currentScoresBackfill: backfill });
    source = await currentScore(c.db, "set"); expect(withCurrentScore(c.db, source).select().from(source).toSQL().sql).not.toContain("distinct on");
    await expectNoDrift(c.db);
    expect((await c.sql`show lock_timeout`)[0]!.lock_timeout).toBe("0");
  } finally { await c.close(); }
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

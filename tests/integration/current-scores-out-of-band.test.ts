import { finished } from "node:stream/promises";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, inject, it, vi } from "vitest";
import { closeDb, createConnection, getDb } from "@/lib/db/client";
import { checkCurrentScores, currentScoresHealth, repairCurrentScores } from "@/lib/db/repos/current-scores";
import { maintainCurrentScores } from "@/lib/cycle/current-scores";
import { noopSpan } from "@/lib/activity/noop";
import { jobs } from "@/lib/db/schema";
import { expectNoDrift, fixture, scoreRow, scores } from "./current-scores-support";
beforeAll(() => { process.env.DATABASE_URL = inject("testDatabaseUrl"); }); afterAll(closeDb);
it("repairs INSERT UPDATE DELETE and cascade orphans, records differences, stays quiet at steady state", async () => {
  const db = getDb(); const all = await fixture(db, 2); const note = vi.fn(); const activity = { ...noopSpan, note };
  const [row] = await db.insert(scores).values(scoreRow(all[0]!.id)).returning();
  const repair = async (count: number) => {
    const before = note.mock.calls.length;
    expect((await maintainCurrentScores(db, activity)).differences).toBe(count);
    expect(note.mock.calls.length - before).toBe(count > 0 ? 1 : 0);
    expect(await currentScoresHealth(db)).toMatchObject({ differences: count, remaining: 0 });
    await expectNoDrift(db);
  };
  expect(await checkCurrentScores(db)).toEqual([all[0]!.id]); await repair(1);
  await db.update(scores).set({ score: 85 }).where(eq(scores.id, row!.id)); await repair(1);
  await db.delete(scores).where(eq(scores.id, row!.id)); await repair(1);
  await db.insert(scores).values(scoreRow(all[1]!.id)); await repair(1);
  await db.delete(jobs).where(eq(jobs.id, all[1]!.id)); await repair(1);
  await repair(0);
});
it.each(["scores", "jobs cascade"])("repairs out-of-band TRUNCATE %s", async (target) => {
  const db = getDb(); const [job] = await fixture(db); await db.insert(scores).values(scoreRow(job!.id)); await repairCurrentScores(db, [job!.id]);
  await db.execute(sql.raw(`truncate ${target}`));
  expect((await checkCurrentScores(db)).length).toBe(1); await maintainCurrentScores(db); await expectNoDrift(db);
});
it("repairs COPY and an old binary write without disturbing other jobs", async () => {
  const db = getDb(); const all = await fixture(db, 2); await db.insert(scores).values(scoreRow(all[0]!.id)); await repairCurrentScores(db, [all[0]!.id]);
  const connection = createConnection(inject("testDatabaseUrl"), { max: 1 });
  try {
    const stream = await connection.sql`copy scores (job_id, filter_result, score, rank_value) from stdin with csv`.writable();
    stream.end(`${all[1]!.id},passed,80,80\n`); await finished(stream);
  } finally { await connection.sql.end(); }
  expect(await checkCurrentScores(db)).toEqual([all[1]!.id]); await maintainCurrentScores(db); await expectNoDrift(db);
  await db.execute(sql`update scores set stale = true where job_id = ${all[0]!.id}`);
  expect(await checkCurrentScores(db)).toEqual([all[0]!.id]); await maintainCurrentScores(db); await expectNoDrift(db);
});

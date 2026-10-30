import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, inject, it } from "vitest";
import { closeDb, getDb } from "@/lib/db/client";
import { jobCurrentScores } from "@/lib/db/schema";
import { checkCurrentScores, repairCurrentScores, scoreTransaction } from "@/lib/db/repos/current-scores";
import { fixture, expectNoDrift, scoreRow, scores } from "./current-scores-support";
beforeAll(() => { process.env.DATABASE_URL = inject("testDatabaseUrl"); }); afterAll(closeDb);
it("matches independent expected values for ties, fallback, filtering and missing scores", async () => {
  const db = getDb(); const all = await fixture(db, 5); const ids = all.map((row) => row.id);
  const at = new Date("2026-01-01T00:00:00Z");
  await scoreTransaction(db, async (tx) => {
    await tx.insert(scores).values([
      { ...scoreRow(ids[0]!, 50), createdAt: at, signalBonus: 2.25, rankValue: 52.25, germanLevel: "b1", stale: true },
      { ...scoreRow(ids[0]!, 80), createdAt: at, signalBonus: 3.5, rankValue: 83.5, summaries: { en: "Winner", zh: "最新" } },
      { ...scoreRow(ids[1]!, 60), createdAt: at, summaryEn: "Older", germanLevel: "b2" },
      { ...scoreRow(ids[1]!, null), createdAt: new Date(at.getTime() + 1), filterReasons: ["latest"] },
      { ...scoreRow(ids[2]!, 90), createdAt: at },
      { ...scoreRow(ids[2]!, null), createdAt: new Date(at.getTime() + 1), filterResult: "filtered_out", filterReasons: ["blocked"] },
      scoreRow(ids[3]!, null),
    ]); tx.touch(ids);
  });
  const rows = await db.select().from(jobCurrentScores).orderBy(jobCurrentScores.jobId);
  expect(rows).toHaveLength(4);
  expect(rows[0]).toMatchObject({ score: 80, rankValue: 83.5, signalBonus: 3.5, stale: false, summaries: { en: "Winner", zh: "最新" } });
  expect(rows[1]).toMatchObject({ score: 60, stale: true, filterReasons: ["latest"], summaryEn: "Older", germanLevel: "b2" });
  expect(rows[2]).toMatchObject({ score: null, stale: false, filterResult: "filtered_out", filterReasons: ["blocked"] });
  expect(rows[3]).toMatchObject({ score: null, stale: false });
  await expectNoDrift(db);
});
it("does not update the projection tuple when only non-display fields change", async () => {
  const db = getDb(); const [job] = await fixture(db);
  await scoreTransaction(db, async (tx) => { await tx.insert(scores).values(scoreRow(job!.id)); tx.touch([job!.id]); });
  const read = async () => (await db.execute<{ xmin: string }>(sql`select xmin::text from job_current_scores`))[0]!.xmin;
  const before = await read();
  await scoreTransaction(db, async (tx) => { await tx.update(scores).set({ fitReasons: ["reason"], filterInputHash: "hash", reasonEvidence: {} }).where(eq(scores.jobId, job!.id)); tx.touch([job!.id]); });
  expect(await read()).toBe(before); await expectNoDrift(db);
});
it("removes the projection after the last score is deleted and refreshes an empty set without SQL", async () => {
  const db = getDb(); const [job] = await fixture(db);
  await db.insert(scores).values(scoreRow(job!.id)); await repairCurrentScores(db, [job!.id]);
  await scoreTransaction(db, async (tx) => { await tx.delete(scores).where(eq(scores.jobId, job!.id)); tx.touch([job!.id]); });
  expect(await db.select().from(jobCurrentScores)).toEqual([]);
  await scoreTransaction(db, async () => {}); expect(await checkCurrentScores(db)).toEqual([]);
});

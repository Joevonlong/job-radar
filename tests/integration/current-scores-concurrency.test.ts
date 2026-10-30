import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, inject, it } from "vitest";
import { closeDb, getDb } from "@/lib/db/client";
import { repairCurrentScores, scoreTransaction } from "@/lib/db/repos/current-scores";
import { maintainCurrentScores } from "@/lib/cycle/current-scores";
import { jobCurrentScores } from "@/lib/db/schema";
import { barrier, expectNoDrift, fixture, scoreRow, scores } from "./current-scores-support";
beforeAll(() => { process.env.DATABASE_URL = inject("testDatabaseUrl"); }); afterAll(closeDb);
it.each([true, false])("handles concurrent first inserts when newer commits first = %s", async (newerFirst) => {
  const db = getDb(); const [job] = await fixture(db); const entered = barrier(), release = barrier();
  const firstScore = newerFirst ? 90 : 40, secondScore = newerFirst ? 40 : 90;
  const first = scoreTransaction(db, async (tx) => {
    await tx.insert(scores).values({ ...scoreRow(job!.id, firstScore), createdAt: new Date(firstScore * 1000) }); tx.touch([job!.id]);
    entered.release(); await release.promise;
  });
  await entered.promise;
  try {
    await scoreTransaction(db, async (tx) => { await tx.insert(scores).values({ ...scoreRow(job!.id, secondScore), createdAt: new Date(secondScore * 1000) }); tx.touch([job!.id]); });
  } finally { release.release(); await first; }
  expect((await db.select().from(jobCurrentScores))[0]!.score).toBe(90); await expectNoDrift(db);
});
it("handles deletion of the last row concurrent with insertion", async () => {
  const db = getDb(); const [job] = await fixture(db); const entered = barrier(), release = barrier();
  const [old] = await db.insert(scores).values(scoreRow(job!.id, 40)).returning(); await repairCurrentScores(db, [job!.id]);
  const deleting = scoreTransaction(db, async (tx) => { await tx.delete(scores).where(eq(scores.id, old!.id)); tx.touch([job!.id]); entered.release(); await release.promise; });
  await entered.promise;
  try { await scoreTransaction(db, async (tx) => { await tx.insert(scores).values(scoreRow(job!.id, 90)); tx.touch([job!.id]); }); }
  finally { release.release(); await deleting; }
  expect((await db.select().from(jobCurrentScores))[0]!.score).toBe(90); await expectNoDrift(db);
});
it("finishes opposite-order crossed buckets without introducing a deadlock", async () => {
  const db = getDb(); const all = await fixture(db, 263); const groups = [[all[2]!.id, all[6]!.id], [all[262]!.id, all[258]!.id]];
  const gates = [barrier(), barrier()];
  await Promise.all(groups.map((ids, i) => scoreTransaction(db, async (tx) => {
    for (const id of ids) { await tx.insert(scores).values(scoreRow(id)); tx.touch([id]); }
    gates[i]!.release(); await gates[1 - i]!.promise;
  })));
  await expectNoDrift(db);
});
it("converges while maintenance repairs compete with application writes", async () => {
  const db = getDb(); const [job] = await fixture(db);
  const [row] = await db.insert(scores).values(scoreRow(job!.id)).returning();
  await Promise.all([
    (async () => { for (let i = 0; i < 12; i++) await scoreTransaction(db, async (tx) => { await tx.update(scores).set({ score: i, rankValue: i }).where(eq(scores.id, row!.id)); tx.touch([job!.id]); }); })(),
    (async () => { for (let i = 0; i < 4; i++) await maintainCurrentScores(db); })(),
  ]);
  await expectNoDrift(db);
});
it("recomputes after an interleaved update to two score rows", async () => {
  const db = getDb(); const [job] = await fixture(db); const [s1, s2] = await db.insert(scores).values([scoreRow(job!.id, 30), scoreRow(job!.id, 40)]).returning();
  await repairCurrentScores(db, [job!.id]); const entered = barrier(), release = barrier();
  const first = scoreTransaction(db, async (tx) => {
    await tx.update(scores).set({ stale: true }).where(eq(scores.id, s1!.id)); tx.touch([job!.id]); entered.release(); await release.promise;
    await tx.update(scores).set({ score: 95, rankValue: 95 }).where(eq(scores.id, s2!.id)); tx.touch([job!.id]);
  });
  await entered.promise;
  try { await scoreTransaction(db, async (tx) => { await tx.update(scores).set({ score: 80, rankValue: 80 }).where(eq(scores.id, s2!.id)); tx.touch([job!.id]); }); }
  finally { release.release(); await first; }
  expect((await db.select().from(jobCurrentScores))[0]!.score).toBe(95); await expectNoDrift(db);
});
it.each([true, false])("serializes saveScore against profile staleness, save first = %s", async (saveFirst) => {
  const { sql } = await import("drizzle-orm");
  const { profileSnapshots } = await import("@/lib/db/schema");
  const { saveScore, markScoresStaleExcept } = await import("@/lib/db/repos/scores");
  const db = getDb(); const [job] = await fixture(db);
  const [snapshot] = await db.insert(profileSnapshots).values({ kind: "preferences", hash: "concurrent", contentYaml: "fixture" }).returning();
  const [row] = await db.insert(scores).values({ ...scoreRow(job!.id, 40), profileSnapshotId: snapshot!.id }).returning(); await repairCurrentScores(db, [job!.id]);
  const input = { rowId: row!.id, jobId: job!.id, profileSnapshotId: snapshot!.id, provider: "fixture", model: "fixture", score: 80, aiScore: 80, germanPenalty: 0, germanLevel: "unknown", germanLevelAi: "unknown", germanLevelSource: "agree", signalBonus: 0, rankValue: 80, fitReasons: [], gaps: [], summaries: { en: "Concurrent" }, outputLang: "en", promptVersion: "concurrent" };
  const entered = barrier(), release = barrier();
  const first = scoreTransaction(db, async (tx) => {
    if(saveFirst) await saveScore(tx, input); else await markScoresStaleExcept(tx, snapshot!.id + 1);
    entered.release(); await release.promise;
  });
  await entered.promise;
  const second = scoreTransaction(db, async (tx) => { if(saveFirst) await markScoresStaleExcept(tx, snapshot!.id + 1); else await saveScore(tx, input); });
  try {
    const deadline = Date.now() + 5000; let waiting = false;
    while(!waiting && Date.now() < deadline) {
      const [state] = await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock') as waiting`);
      waiting = state?.waiting === true; if(!waiting) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(waiting).toBe(true);
  } finally { release.release(); await Promise.all([first, second]); }
  expect((await db.select().from(jobCurrentScores))[0]).toMatchObject({ score: 80, stale: saveFirst }); await expectNoDrift(db);
});

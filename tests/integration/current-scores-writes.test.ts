import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, expect, inject, it } from "vitest";
import { closeDb, getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { jobCurrentScores, profileSnapshots } from "@/lib/db/schema";
import { repairCurrentScores, scoreTransaction } from "@/lib/db/repos/current-scores";
import { insertFilterResults, updateFilterResult } from "@/lib/db/repos/filter-results";
import { markScoresStaleByPromptVersion, markScoresStaleExcept, saveScore, updateGermanOutcome } from "@/lib/db/repos/scores";
import { setScoreBonuses } from "@/lib/db/repos/signals";
import { fixture, expectNoDrift, scoreRow, scores } from "./current-scores-support";
beforeAll(() => { process.env.DATABASE_URL = inject("testDatabaseUrl"); }); afterAll(closeDb);
it("covers filter insert/update, AI score, profile/prompt staleness, German outcome and bonus reconciliation", async () => {
  const db = getDb(); const [job] = await fixture(db);
  const [snapshot] = await db.insert(profileSnapshots).values({ kind: "preferences", hash: "snapshot", contentYaml: "fixture" }).returning();
  await scoreTransaction(db, async (tx) => { expect(await insertFilterResults(tx, snapshot!.id, [{ jobId: job!.id, filterResult: "passed", filterReasons: [] }])).toBe(1); }); await expectNoDrift(db);
  const [row] = await db.select().from(scores);
  await scoreTransaction(db, (tx) => saveScore(tx, { rowId: row!.id, jobId: job!.id, profileSnapshotId: snapshot!.id, provider: "fixture", model: "fixture", score: 70, aiScore: 75, germanPenalty: 5, germanLevel: "b1", germanLevelAi: "b1", germanLevelSource: "agree", signalBonus: 1.5, rankValue: 71.5, fitReasons: [], gaps: [], summaries: { en: "Scored", zh: "评分" }, outputLang: "en", promptVersion: "old" })); await expectNoDrift(db);
  await scoreTransaction(db, (tx) => markScoresStaleExcept(tx, snapshot!.id + 1)); await expectNoDrift(db);
  await scoreTransaction(db, async (tx) => { await tx.update(scores).set({ stale: false }); tx.touch([job!.id]); });
  await scoreTransaction(db, (tx) => markScoresStaleByPromptVersion(tx, "new")); await expectNoDrift(db);
  await scoreTransaction(db, (tx) => updateGermanOutcome(tx, row!.id, { germanLevel: "c1", germanLevelSource: "rule", germanPenalty: 10, score: 65, rankValue: 66.5 })); await expectNoDrift(db);
  await scoreTransaction(db, (tx) => setScoreBonuses(tx, [{ scoreId: row!.id, signalBonus: 2.25, rankValue: 67.25 }])); await expectNoDrift(db);
  await scoreTransaction(db, (tx) => updateFilterResult(tx, row!.id, { filterResult: "filtered_out", filterReasons: ["excluded"] })); await expectNoDrift(db);
  expect((await db.select().from(jobCurrentScores))[0]).toMatchObject({ filterResult: "filtered_out", rankValue: 67.25 });
});
it("rolls back callback failures and refresh failures atomically", async () => {
  const db = getDb(); const [job] = await fixture(db);
  await expect(scoreTransaction(db, async (tx) => { await tx.insert(scores).values(scoreRow(job!.id)); tx.touch([job!.id]); throw new Error("callback failed"); })).rejects.toThrow("callback failed");
  expect(await db.select().from(scores)).toEqual([]);
  await db.execute(sql`create function reject_projection() returns trigger language plpgsql as $$ begin raise exception 'refresh failed'; end $$`);
  await db.execute(sql`create trigger reject_projection before insert on job_current_scores for each row execute function reject_projection()`);
  try {
    await expect(scoreTransaction(db, async (tx) => { await tx.insert(scores).values(scoreRow(job!.id)); tx.touch([job!.id]); })).rejects.toThrow();
    expect(await db.select().from(scores)).toEqual([]); await expectNoDrift(db);
  } finally { await db.execute(sql`drop trigger reject_projection on job_current_scores`); await db.execute(sql`drop function reject_projection()`); }
});
it("retains pre-savepoint writes, rolls back inner writes and refreshes only once at the outer boundary", async () => {
  const db = getDb(); const all = await fixture(db, 2);
  await scoreTransaction(db, async (tx) => {
    await tx.insert(scores).values(scoreRow(all[0]!.id)); tx.touch([all[0]!.id]);
    await expect(scoreTransaction(tx, async (inner) => { await inner.insert(scores).values(scoreRow(all[1]!.id)); inner.touch([all[1]!.id]); throw new Error("savepoint"); })).rejects.toThrow("savepoint");
    await scoreTransaction(tx, async (inner) => { await inner.update(scores).set({ score: 80, rankValue: 80 }).where(eq(scores.jobId, all[0]!.id)); inner.touch([all[0]!.id]); });
    expect(await tx.select().from(jobCurrentScores)).toEqual([]);
  });
  expect(await db.select().from(jobCurrentScores)).toHaveLength(1); await expectNoDrift(db);
});
it.each(["repeatable read", "serializable"] as const)("rejects %s isolation with an explanatory error", async (isolationLevel) => {
  const db = getDb(); const [job] = await fixture(db);
  const error = await scoreTransaction(db, async (tx) => { await tx.execute(sql.raw(`set transaction isolation level ${isolationLevel}`)); await tx.insert(scores).values(scoreRow(job!.id)); tx.touch([job!.id]); }).catch((error: unknown) => error);
  const message = (value: unknown): string => value instanceof Error ? `${value.message} ${message(value.cause)}` : "";
  expect(message(error)).toContain("READ COMMITTED"); expect(await db.select().from(scores)).toEqual([]);
});
it("refreshes ten thousand affected jobs with one scoped statement", async () => {
  const db = getDb(); const all = await fixture(db, 10000);
  await scoreTransaction(db, async (tx) => {
    await tx.execute(sql`insert into scores (job_id, filter_result, score, rank_value) select id, 'passed', 50, 50 from jobs`);
    tx.touch(all.map((row) => row.id));
  });
  expect(await db.select({ id: jobCurrentScores.jobId }).from(jobCurrentScores)).toHaveLength(10000); await expectNoDrift(db);
  await repairCurrentScores(db, all.map((row) => row.id)); await expectNoDrift(db);
});
it("sends no refresh SQL for empty registration or an update matching zero rows", async () => {
  const db = getDb(); const statements: string[] = [];
  await scoreTransaction(db, async (tx) => {
    const execute = tx.execute.bind(tx);
    tx.execute = ((query: Parameters<typeof tx.execute>[0]) => { statements.push(String(query)); return execute(query); }) as typeof tx.execute;
    tx.touch([]);
  });
  expect(statements).toEqual([]);
  // every statement of the transaction, through a client that logs them: the update itself and nothing after it
  const client = postgres(inject("testDatabaseUrl"), { max: 1, onnotice: () => {} });
  const logged: string[] = [];
  const logging = drizzle(client, { schema, logger: { logQuery: (query) => { logged.push(query); } } });
  try {
    await scoreTransaction(logging, async (tx) => { expect(await markScoresStaleExcept(tx, 123)).toBe(0); });
    await scoreTransaction(logging, async (tx) => {
      const rows = await tx.update(scores).set({ stale: true }).where(eq(scores.id, -1)).returning({ jobId: scores.jobId });
      tx.touch(rows.map((row) => row.jobId));
    });
  } finally { await client.end(); }
  expect(logged).toHaveLength(2);
  for (const query of logged) {
    expect(query).toMatch(/^update "scores"/);
    expect(query).not.toMatch(/job_current_scores|to_regclass/);
  }
  await expectNoDrift(db);
});

it("rejects refreshing inside an unbranded outer transaction", async () => {
  await expect(getDb().transaction((tx) => scoreTransaction(tx, async () => {}))).rejects.toThrow("outer score writer");
});
it("keeps a fixed-seed sequence of repository writes consistent", async () => {
  const db = getDb(); const all = await fixture(db, 8);
  const snapshots = await db.insert(profileSnapshots).values(Array.from({ length: 4 }, (_, i) => ({ kind: "preferences" as const, hash: `random-${i}`, contentYaml: "fixture" }))).returning();
  let seed = 42;
  const random = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % limit; };
  for(let step = 0; step < 64; step++) {
    const job = all[random(all.length)]!, snapshot = snapshots[random(snapshots.length)]!;
    const rows = await db.select().from(scores); const row = rows.length ? rows[random(rows.length)]! : null;
    await scoreTransaction(db, async (tx) => {
      switch(step < 6 ? step : random(6)) {
        case 0: await insertFilterResults(tx, snapshot.id, [{ jobId: job.id, filterResult: "passed", filterReasons: [] }]); break;
        case 1: if(row) await updateFilterResult(tx, row.id, { filterResult: step % 2 ? "passed" : "filtered_out", filterReasons: [`reason-${step}`] }); break;
        case 2: if(row) await saveScore(tx, { rowId: row.id, jobId: row.jobId, profileSnapshotId: row.profileSnapshotId!, provider: "fixture", model: "fixture", score: step, aiScore: step, germanPenalty: 0, germanLevel: "unknown", germanLevelAi: "unknown", germanLevelSource: "agree", signalBonus: 0, rankValue: step, fitReasons: [], gaps: [], summaries: { en: `Step ${step}` }, outputLang: "en", promptVersion: "random" }); break;
        case 3: await markScoresStaleExcept(tx, snapshot.id); break;
        case 4: if(row) await setScoreBonuses(tx, [{ scoreId: row.id, signalBonus: 2.5, rankValue: row.score === null ? null : row.score + 2.5 }]); break;
        case 5: if(row?.score !== null && row) await updateGermanOutcome(tx, row.id, { germanLevel: "b1", germanLevelSource: "rule", germanPenalty: 0, score: row.score, rankValue: row.score + row.signalBonus }); break;
      }
    });
    await expectNoDrift(db);
  }
});

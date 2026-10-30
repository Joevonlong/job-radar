import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, inject, it } from "vitest";

import { closeDb, getDb, type Db } from "@/lib/db/client";
import { scoreTransaction } from "@/lib/db/repos/current-scores";
import { markScoresStaleByPromptVersion, markScoresStaleExcept } from "@/lib/db/repos/scores";
import { setScoreBonuses } from "@/lib/db/repos/signals";
import { companies, jobs, profileSnapshots, scores } from "@/lib/db/schema";
import { runFilter } from "@/lib/filter";

import { prefs } from "../filter/helpers";
import { shippedPipeline } from "../pipeline/helpers";
import { barrier, expectNoDrift } from "./current-scores-support";

// Every multi-row scores write takes its row locks in ascending scores.id order. The fixture makes job id order the
// reverse of score id (and physical) order: a writer going by job id against one going by scan order would deadlock.
// A third connection holds the lowest score row; both writers queue on it before it is released, the stale-mark first.

beforeAll(() => { process.env.DATABASE_URL = inject("testDatabaseUrl"); });
afterAll(closeDb);

const ROWS = 200;

async function reversedFixture(db: Db) {
  const [company] = await db.insert(companies).values({ name: "Lock Order", nameNorm: "lock order" }).returning();
  const created = await db.insert(jobs).values(Array.from({ length: ROWS }, (_, i) => ({
    companyId: company!.id, title: `Engineer ${i}`, titleNorm: `engineer ${i}`, description: "Build software.", workplace: "remote" as const, contract: "permanent",
  }))).returning({ id: jobs.id });
  const [snapshot] = await db.insert(profileSnapshots).values({ kind: "preferences", hash: `lock-order-${Date.now()}`, contentYaml: "fixture" }).returning();
  // one insert per row, highest job first: score ids (and the heap order) run opposite to job ids
  for (const { id } of [...created].reverse()) {
    await db.insert(scores).values({ jobId: id, profileSnapshotId: snapshot!.id, filterResult: "passed", score: 70, rankValue: 70, signalBonus: 0, promptVersion: "old", summaries: { en: "Summary" }, outputLang: "en" });
  }
  const rows = await db.select({ id: scores.id, jobId: scores.jobId }).from(scores).orderBy(scores.id);
  expect(rows[0]!.jobId).toBe(created[created.length - 1]!.id);
  return { snapshotId: snapshot!.id, rows };
}

async function lockWaiters(db: Db): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
  return row?.n ?? 0;
}

async function waitForLockWaiters(db: Db, n: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while ((await lockWaiters(db)) < n) {
    if (Date.now() > deadline) throw new Error(`expected ${n} transactions waiting for a lock`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Hold the lowest score row, start `first` and wait until it queues, then `second`, then release both. */
async function race(db: Db, lowestId: number, first: () => Promise<unknown>, second: () => Promise<unknown>): Promise<PromiseSettledResult<unknown>[]> {
  const locked = barrier(), release = barrier();
  const holder = db.transaction(async (tx) => {
    await tx.execute(sql`select id from scores where id = ${lowestId} for update`);
    locked.release();
    await release.promise;
  });
  await locked.promise;
  const base = await lockWaiters(db);
  const a = first();
  await waitForLockWaiters(db, base + 1);
  const b = second();
  await waitForLockWaiters(db, base + 2);
  release.release();
  await holder;
  return Promise.allSettled([a, b]);
}

function expectNoDeadlock(results: PromiseSettledResult<unknown>[]): void {
  const failures = results.flatMap((r) => r.status === "rejected" ? [r.reason as { code?: string; cause?: { code?: string }; message?: string }] : []);
  expect(failures.map((e) => e.cause?.code ?? e.code ?? e.message)).toEqual([]);
}

it.each([1, 2, 3])("a filter batch and a full profile stale-mark on reversed rows finish without a deadlock (round %i)", async () => {
  const db = getDb();
  const { snapshotId, rows } = await reversedFixture(db);
  const pipeline = shippedPipeline();
  const options = { snapshotId, preferences: prefs(), pipeline: { ...pipeline, batch_size: ROWS + 10 }, me: null, watchedCompanies: [] as string[] };
  const results = await race(db, rows[0]!.id,
    () => scoreTransaction(db, (tx) => markScoresStaleExcept(tx, snapshotId + 1_000_000)),
    () => runFilter(db, options));
  expectNoDeadlock(results);
  const [stale] = await db.execute<{ n: number }>(sql`select count(*)::int as n from scores where stale`);
  expect(stale?.n).toBe(ROWS);
  await expectNoDrift(db);
});

it.each([1, 2, 3])("a bonus reconcile in descending score order and a prompt stale-mark finish without a deadlock (round %i)", async () => {
  const db = getDb();
  const { rows } = await reversedFixture(db);
  const updates = [...rows].reverse().map((row, i) => ({ scoreId: row.id, signalBonus: 1, rankValue: 71 + (i % 3) }));
  const results = await race(db, rows[0]!.id,
    () => scoreTransaction(db, (tx) => markScoresStaleByPromptVersion(tx, "new")),
    () => scoreTransaction(db, (tx) => setScoreBonuses(tx, updates)));
  expectNoDeadlock(results);
  const [counts] = await db.execute<{ stale: number; bonus: number }>(sql`select count(*) filter (where stale)::int as stale, count(*) filter (where signal_bonus = 1)::int as bonus from scores`);
  expect(counts).toEqual({ stale: ROWS, bonus: ROWS });
  await expectNoDrift(db);
});

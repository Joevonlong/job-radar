import { eq, sql, type SQL } from "drizzle-orm";
import { afterAll, expect, inject, it } from "vitest";

import { createConnection } from "@/lib/db/client";
import { scoreTransaction, type ScoreTx } from "@/lib/db/repos/current-scores";
import { insertFilterResults, updateFilterResult, type NewFilterResult } from "@/lib/db/repos/filter-results";
import { markScoresStaleByPromptVersion, markScoresStaleExcept } from "@/lib/db/repos/scores";
import { agentChanges, companies, jobs, profileSnapshots, scores } from "@/lib/db/schema";
import { SYNC_BLOCKS, SYNC_SOURCES } from "@/lib/db/sync-sources";

const connection = createConnection(inject("testDatabaseUrl"), { max: 1 });
const { db } = connection;
afterAll(async () => { await connection.sql.end({ timeout: 5 }); });

const first = new Date("2026-05-01T08:00:00Z");
const later = new Date("2026-05-01T09:00:00Z");
const scoreFor = (jobId: number) => ({ jobId, filterResult: "passed" as const, score: 60, rankValue: 60, createdAt: first });
const jobChange = (jobId: number, blocks = 129, removed = 0) => ({ key_kind: "job", key: String(jobId), blocks, removed });
type Change = ReturnType<typeof jobChange>;
type Write = (tx: ScoreTx) => Promise<void>;

async function seedJobs(count: number) {
  const [company] = await db.insert(companies).values({ name: "Example Engineering", nameNorm: "example engineering" })
    .returning({ id: companies.id });
  const rows = await db.insert(jobs).values(Array.from({ length: count }, () => ({
    companyId: company!.id, title: "Engineer", titleNorm: "engineer", firstSeenAt: first, lastSeenAt: first,
  }))).returning({ id: jobs.id });
  return rows.map(({ id }) => id);
}

async function seedScore() {
  const [jobId, otherJobId, spareJobId] = await seedJobs(3);
  const [row] = await db.insert(scores).values(scoreFor(jobId!)).returning({ id: scores.id });
  return { jobId: jobId!, otherJobId: otherJobId!, spareJobId: spareJobId!, scoreId: row!.id };
}

/** The original score row triggers use the shared job-child and append functions. */
async function installRowTriggers(tx: ScoreTx) {
  await tx.execute(sql`
    alter table public.scores
      disable trigger agent_change_insert,
      disable trigger agent_change_delete,
      disable trigger agent_change_update`);
  await tx.execute(sql`
    CREATE FUNCTION public.test_agent_changes_scores_update_row() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      change_blocks integer;
    BEGIN
      change_blocks := CASE WHEN OLD.job_id IS DISTINCT FROM NEW.job_id OR OLD.id IS DISTINCT FROM NEW.id OR
        OLD.score IS DISTINCT FROM NEW.score OR OLD.stale IS DISTINCT FROM NEW.stale OR
        OLD.german_level IS DISTINCT FROM NEW.german_level OR OLD.filter_result IS DISTINCT FROM NEW.filter_result OR
        OLD.created_at IS DISTINCT FROM NEW.created_at THEN 1 | 128 ELSE 0 END |
        CASE WHEN OLD.rank_value IS DISTINCT FROM NEW.rank_value THEN 1 ELSE 0 END |
        CASE WHEN OLD.ai_score IS DISTINCT FROM NEW.ai_score OR OLD.german_penalty IS DISTINCT FROM NEW.german_penalty OR
        OLD.filter_reasons IS DISTINCT FROM NEW.filter_reasons OR OLD.fit_reasons IS DISTINCT FROM NEW.fit_reasons OR
        OLD.gaps IS DISTINCT FROM NEW.gaps OR OLD.reason_evidence IS DISTINCT FROM NEW.reason_evidence OR
        OLD.summaries IS DISTINCT FROM NEW.summaries OR OLD.summary_zh IS DISTINCT FROM NEW.summary_zh OR
        OLD.summary_en IS DISTINCT FROM NEW.summary_en OR OLD.output_lang IS DISTINCT FROM NEW.output_lang OR
        OLD.scored_at IS DISTINCT FROM NEW.scored_at THEN 128 ELSE 0 END;
      PERFORM public.agent_changes_append('job', OLD.job_id::text, NEW.job_id::text, change_blocks);
      RETURN NULL;
    END;
    $$`);
  await tx.execute(sql`
    CREATE TRIGGER agent_change_reference_presence AFTER INSERT OR DELETE ON public.scores
      FOR EACH ROW EXECUTE FUNCTION public.agent_changes_job_child('129')`);
  await tx.execute(sql`
    CREATE TRIGGER agent_change_reference_update AFTER UPDATE ON public.scores FOR EACH ROW WHEN (
      OLD.job_id IS DISTINCT FROM NEW.job_id OR
      OLD.id IS DISTINCT FROM NEW.id OR
      OLD.score IS DISTINCT FROM NEW.score OR
      OLD.stale IS DISTINCT FROM NEW.stale OR
      OLD.german_level IS DISTINCT FROM NEW.german_level OR
      OLD.filter_result IS DISTINCT FROM NEW.filter_result OR
      OLD.created_at IS DISTINCT FROM NEW.created_at OR
      OLD.rank_value IS DISTINCT FROM NEW.rank_value OR
      OLD.ai_score IS DISTINCT FROM NEW.ai_score OR
      OLD.german_penalty IS DISTINCT FROM NEW.german_penalty OR
      OLD.filter_reasons IS DISTINCT FROM NEW.filter_reasons OR
      OLD.fit_reasons IS DISTINCT FROM NEW.fit_reasons OR
      OLD.gaps IS DISTINCT FROM NEW.gaps OR
      OLD.reason_evidence IS DISTINCT FROM NEW.reason_evidence OR
      OLD.summaries IS DISTINCT FROM NEW.summaries OR
      OLD.summary_zh IS DISTINCT FROM NEW.summary_zh OR
      OLD.summary_en IS DISTINCT FROM NEW.summary_en OR
      OLD.output_lang IS DISTINCT FROM NEW.output_lang OR
      OLD.scored_at IS DISTINCT FROM NEW.scored_at
    ) EXECUTE FUNCTION public.test_agent_changes_scores_update_row()`);
}

/** Read the score changes before the transaction refreshes the current-score projection. */
async function captureChanges(write: Write, mode: "statement" | "row") {
  const rollback = new Error("roll back score writes and trigger setup");
  let changes = new Set<Change>();
  await scoreTransaction(db, async (tx) => {
    if (mode === "row") await installRowTriggers(tx);
    await write(tx);
    const grouped = await tx.execute<Change & { same_tx: boolean }>(sql`
      select key_kind, key, bit_or(blocks) as blocks, bit_or(removed) as removed,
        bool_and(tx = pg_current_xact_id()) as same_tx
      from public.agent_changes group by key_kind, key`);
    changes = new Set(grouped.map(({ same_tx, ...change }) => {
      expect(same_tx, `${mode} trigger logged ${change.key} in the top-level transaction`).toBe(true);
      return change;
    }));
    throw rollback;
  }).catch((error: unknown) => {
    if (error !== rollback) throw error;
  });
  return changes;
}

async function expectEquivalent(write: Write, expected: readonly Change[]) {
  await db.delete(agentChanges);
  const statement = await captureChanges(write, "statement");
  const row = await captureChanges(write, "row");
  expect(statement).toEqual(row);
  expect(statement).toEqual(new Set(expected));
}

it("logs a single score insert", async () => {
  const [jobId] = await seedJobs(1);
  await expectEquivalent(async (tx) => {
    await tx.insert(scores).values(scoreFor(jobId!));
  }, [jobChange(jobId!)]);
});

it("logs a multi-row insert with repeated job keys", async () => {
  const [jobId, otherJobId] = await seedJobs(2);
  await expectEquivalent(async (tx) => {
    await tx.insert(scores).values([scoreFor(jobId!), scoreFor(jobId!), scoreFor(otherJobId!)]);
  }, [jobChange(jobId!), jobChange(otherJobId!)]);
});

it("logs deleting multiple scores for surviving jobs", async () => {
  const { jobId, otherJobId } = await seedScore();
  await db.insert(scores).values([scoreFor(jobId), scoreFor(otherJobId)]);
  await expectEquivalent(async (tx) => {
    const deleted = await tx.delete(scores).returning({ id: scores.id });
    expect(deleted).toHaveLength(3);
  }, [jobChange(jobId), jobChange(otherJobId)]);
});

it("skips score deletions when a job is deleted and its scores cascade", async () => {
  const { jobId, otherJobId } = await seedScore();
  await db.insert(scores).values([scoreFor(jobId), scoreFor(otherJobId)]);
  await expectEquivalent(async (tx) => {
    await tx.delete(jobs).where(eq(jobs.id, jobId));
    const remaining = await tx.select({ jobId: scores.jobId }).from(scores);
    expect(remaining).toEqual([{ jobId: otherJobId }]);
    const raw = await tx.select({ blocks: agentChanges.blocks, removed: agentChanges.removed }).from(agentChanges);
    expect(raw).toEqual([{ blocks: 1023, removed: 1 }]);
  }, [jobChange(jobId, 1023, 1)]);
});

const scoreColumnCases = SYNC_SOURCES.filter(({ table, operations }) => table === "scores" && operations.includes("update"))
  .flatMap(({ columns, blocks }) => columns.map((column) => ({
    column, blocks: blocks.reduce((mask, block) => mask | (1 << SYNC_BLOCKS[block].bit), 0),
  })));

it.each(scoreColumnCases)("logs an isolated score update to $column", async ({ column, blocks }) => {
  const { jobId, otherJobId, scoreId } = await seedScore();
  const values: Record<string, SQL> = {
    id: sql`default`, job_id: sql`${otherJobId}`, score: sql`72`, stale: sql`true`, german_level: sql`'B2'`,
    filter_result: sql`'filtered_out'`, created_at: sql`${later.toISOString()}::timestamptz`, rank_value: sql`73`,
    ai_score: sql`75`, german_penalty: sql`3`, filter_reasons: sql`array['Filter reason']`,
    fit_reasons: sql`array['Fit reason']`, gaps: sql`array['Gap']`, reason_evidence: sql`'{"v":1,"fit":[],"gaps":[]}'::jsonb`,
    summaries: sql`'{"en":"Updated summary"}'::jsonb`, summary_zh: sql`'Legacy Chinese summary'`,
    summary_en: sql`'Legacy English summary'`, output_lang: sql`'en'`, scored_at: sql`${later.toISOString()}::timestamptz`,
  };
  expect(values[column], column).toBeDefined();
  const expected = [jobChange(jobId, blocks)];
  if (column === "job_id") expected.push(jobChange(otherJobId, blocks));
  await expectEquivalent(async (tx) => {
    const updated = await tx.execute(sql`update scores set ${sql.identifier(column)} = ${values[column]} where id = ${scoreId}`);
    expect(updated.count).toBe(1);
  }, expected);
});

it("logs both jobs when the score id and job id change together", async () => {
  const { jobId, otherJobId, scoreId } = await seedScore();
  await expectEquivalent(async (tx) => {
    const updated = await tx.execute(sql`update scores set id = default, job_id = ${otherJobId} where id = ${scoreId}`);
    expect(updated.count).toBe(1);
  }, [jobChange(jobId), jobChange(otherJobId)]);
});

it("combines different block masks for scores of one job in one update", async () => {
  const { jobId, scoreId } = await seedScore();
  await db.insert(scores).values(scoreFor(jobId));
  await expectEquivalent(async (tx) => {
    const updated = await tx.update(scores).set({
      rankValue: sql`case when ${scores.id} = ${scoreId} then 62 else ${scores.rankValue} end`,
      aiScore: sql`case when ${scores.id} <> ${scoreId} then 78 else ${scores.aiScore} end`,
    }).where(eq(scores.jobId, jobId)).returning({ id: scores.id });
    expect(updated).toHaveLength(2);
  }, [jobChange(jobId)]);
});

it("ignores a stale flag set to itself", async () => {
  const { scoreId } = await seedScore();
  await expectEquivalent(async (tx) => {
    const updated = await tx.execute(sql`update scores set stale = stale where id = ${scoreId}`);
    expect(updated.count).toBe(1);
  }, []);
});

it("ignores a change to the non-exported score provider", async () => {
  const { scoreId } = await seedScore();
  await expectEquivalent(async (tx) => {
    const updated = await tx.update(scores).set({ provider: "example" }).where(eq(scores.id, scoreId))
      .returning({ provider: scores.provider });
    expect(updated).toEqual([{ provider: "example" }]);
  }, []);
});

it.each(["profile snapshot", "prompt version"] as const)("logs bulk stale marking after a %s change", async (reason) => {
  const jobIds = await seedJobs(300);
  const [old, current] = await db.insert(profileSnapshots).values([
    { kind: "preferences", hash: "old preferences", contentYaml: "{}" },
    { kind: "preferences", hash: "current preferences", contentYaml: "{}" },
  ]).returning({ id: profileSnapshots.id });
  await db.insert(scores).values(jobIds.map((jobId) => ({ ...scoreFor(jobId), profileSnapshotId: old!.id, promptVersion: "previous" })));
  await expectEquivalent(async (tx) => {
    const marked = reason === "profile snapshot"
      ? await markScoresStaleExcept(tx, current!.id)
      : await markScoresStaleByPromptVersion(tx, "current");
    expect(marked).toBe(jobIds.length);
  }, jobIds.map((jobId) => jobChange(jobId)));
});

it("logs fresh filter results and ignores conflicts through the filter repository", async () => {
  const [jobId, otherJobId] = await seedJobs(2);
  const [snapshot] = await db.insert(profileSnapshots).values({ kind: "preferences", hash: "filter preferences", contentYaml: "{}" })
    .returning({ id: profileSnapshots.id });
  await db.insert(scores).values({ ...scoreFor(jobId!), profileSnapshotId: snapshot!.id });
  const rows: NewFilterResult[] = [
    { jobId: jobId!, filterResult: "filtered_out", filterReasons: ["Conflict"] },
    { jobId: otherJobId!, filterResult: "passed", filterReasons: [] },
  ];
  await expectEquivalent(async (tx) => {
    expect(await insertFilterResults(tx, snapshot!.id, rows)).toBe(1);
    expect(await insertFilterResults(tx, snapshot!.id, rows)).toBe(0);
    expect(await tx.select({ key: agentChanges.key }).from(agentChanges)).toEqual([{ key: String(otherJobId) }]);
  }, [jobChange(otherJobId!)]);
});

it("logs replacement of an existing filter result through the filter repository", async () => {
  const { jobId, scoreId } = await seedScore();
  await expectEquivalent(async (tx) => {
    await updateFilterResult(tx, scoreId, { filterResult: "filtered_out", filterReasons: ["Excluded"] });
  }, [jobChange(jobId)]);
});

it("logs mixed writes under one transaction id and discards changes from rolled-back savepoints", async () => {
  const { jobId, otherJobId, spareJobId, scoreId } = await seedScore();
  await expectEquivalent(async (tx) => {
    await tx.insert(scores).values(scoreFor(otherJobId));
    const rollback = new Error("roll back a score insert");
    await expect(tx.transaction(async (inner) => {
      await inner.insert(scores).values(scoreFor(spareJobId));
      const logged = await inner.select({ blocks: agentChanges.blocks }).from(agentChanges)
        .where(eq(agentChanges.key, String(spareJobId)));
      expect(logged).toEqual([{ blocks: 129 }]);
      throw rollback;
    })).rejects.toBe(rollback);
    await tx.transaction(async (inner) => {
      await inner.update(scores).set({ aiScore: 75 }).where(eq(scores.id, scoreId));
    });
    await tx.update(scores).set({ rankValue: 74 }).where(eq(scores.id, scoreId));
    await tx.delete(scores).where(eq(scores.jobId, otherJobId));
  }, [jobChange(jobId), jobChange(otherJobId)]);
});

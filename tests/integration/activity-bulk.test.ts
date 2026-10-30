import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createConnection } from "@/lib/db/client";
import { deleteActivityBatch, pruneActivityBatch, resetActivityTablesCache, type ActivityPruneBatch } from "@/lib/db/repos/activity";
import { liveness } from "./activity-helpers";

// Thousands of finished roots must not be deleted one slow transaction at a time. The connection forces JIT for every
// query, so a batch that does not turn it off pays the compile cost on each root-selection query.
const ROOTS = 3000;
const BUDGET_MS = 3000;
const MIN_ROOTS = 1000;
let connection: ReturnType<typeof createConnection>;
beforeAll(() => {
  connection = createConnection(inject("testDatabaseUrl"), {
    max: 1, sessionSettings: { jit_above_cost: 0, jit_inline_above_cost: 0, jit_optimize_above_cost: 0 },
  });
});
beforeEach(() => resetActivityTablesCache());
afterAll(async () => { await connection.sql.end(); });

async function seedRoots(): Promise<void> {
  await connection.db.execute(sql`insert into activity_spans(id,root_id,scope,name,process,status,started_at,finished_at,last_activity_at)
    select id, id, 'system', 'system.backup', 'runner', 'ok', at, at, at
    from (select gen_random_uuid() as id, now() - interval '40 days' - g * interval '1 minute' as at from generate_series(1, ${ROOTS}) g) roots`);
  await connection.db.execute(sql`insert into activity_spans(id,root_id,parent_id,scope,name,process,status,started_at,finished_at,last_activity_at)
    select gen_random_uuid(), id, id, 'system', 'step.collect', 'runner', 'ok', started_at, finished_at, last_activity_at
    from activity_spans where parent_id is null`);
  await connection.db.execute(sql`insert into activity_events(id,root_id,span_id,at,level,code,params)
    select gen_random_uuid(), root_id, id, last_activity_at, 'info', 'item.ok', '{}'::jsonb
    from activity_spans, generate_series(1, 2) where parent_id is not null`);
}
async function remainingRoots(): Promise<number> {
  const [row] = await connection.db.execute<{ n: number }>(sql`select count(*)::int as n from activity_spans where parent_id is null`);
  return row.n;
}
async function within(work: () => Promise<{ roots: number; found: boolean }>): Promise<number> {
  const started = performance.now();
  let roots = 0;
  while (performance.now() - started < BUDGET_MS) {
    const batch = await work();
    roots += batch.roots;
    if (!batch.found) break;
  }
  return roots;
}

describe("bulk activity removal", () => {
  it("clear all removes many roots per time budget without touching anything but complete trees", async () => {
    await seedRoots();
    const deleted = await within(() => deleteActivityBatch(connection.db, {
      scope: { kind: "all" }, asOf: new Date(), liveness, batchSize: 2000, rootsPerBatch: 200,
    }));
    expect(deleted).toBeGreaterThanOrEqual(MIN_ROOTS);
    expect(await remainingRoots()).toBe(ROOTS - deleted);
    // No orphaned children or events of deleted roots remain.
    const [orphans] = await connection.db.execute<{ n: number }>(sql`select
      ((select count(*) from activity_spans s where not exists (select 1 from activity_spans r where r.id = s.root_id))
      + (select count(*) from activity_events e where not exists (select 1 from activity_spans r where r.id = e.root_id)))::int as n`);
    expect(orphans.n).toBe(0);
  });
  it("retention pruning removes many roots per time budget", async () => {
    await seedRoots();
    let rootIds: string[] | undefined;
    const deleted = await within(async () => {
      const batch: ActivityPruneBatch = await pruneActivityBatch(connection.db, {
        days: 30, maxEvents: 1_000_000, batchSize: 2000, rootsPerBatch: 200, liveness, phase: "days", rootIds,
      });
      rootIds = batch.nextRootIds ?? undefined;
      return batch;
    });
    expect(deleted).toBeGreaterThanOrEqual(MIN_ROOTS);
    expect(await remainingRoots()).toBe(ROOTS - deleted);
  });
});

import { and, asc, eq, inArray, isNull, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { ActivityBatch, ActivityProcess } from "@/lib/activity/types";
import { createConnection, databaseUrlFor, type Db } from "../client";
import { activityEvents, activitySpans } from "../schema";

export function openActivityConnection(db: Db, options: { connectTimeoutSeconds: number; statementTimeoutMs: number; lockTimeoutMs: number }) {
  return createConnection(databaseUrlFor(db), {
    max: 1, connectTimeoutSeconds: options.connectTimeoutSeconds,
    sessionSettings: {
      statement_timeout: options.statementTimeoutMs,
      lock_timeout: options.lockTimeoutMs,
      idle_in_transaction_session_timeout: options.statementTimeoutMs,
    },
  });
}

let ready = false;
export async function activityTablesReady(db: Db): Promise<boolean> {
  if (ready) return true;
  const [row] = await db.execute<{ ok: boolean }>(sql`select
    (to_regclass('activity_spans') is not null and to_regclass('activity_events') is not null) as ok`);
  ready = row?.ok === true;
  return ready;
}
export function resetActivityTablesCache(): void { ready = false; }

/** Every statement is replayable even when COMMIT succeeded but its response was lost. */
export async function writeActivityBatch(db: Db, batch: ActivityBatch): Promise<void> {
  await db.transaction(async (tx) => {
    for (let i = 0; i < batch.roots.length; i += batch.batchSize) {
      await tx.insert(activitySpans).values(batch.roots.slice(i, i + batch.batchSize)).onConflictDoNothing();
    }
    const t = activitySpans;
    for (let i = 0; i < batch.spans.length; i += batch.batchSize) {
      await tx.insert(t).values(batch.spans.slice(i, i + batch.batchSize)).onConflictDoUpdate({
        target: t.id,
        set: {
          // A full root replaces an earlier placeholder, including the creating process.
          scope: sql`excluded.scope`, name: sql`excluded.name`, process: sql`excluded.process`,
          parentId: sql`coalesce(excluded.parent_id, ${t.parentId})`,
          status: sql`case when ${t.status} <> 'running' then ${t.status} else excluded.status end`,
          reasonCode: sql`case when ${t.status} <> 'running' then ${t.reasonCode} else coalesce(excluded.reason_code, ${t.reasonCode}) end`,
          startedAt: sql`least(${t.startedAt}, excluded.started_at)`,
          finishedAt: sql`coalesce(${t.finishedAt}, case when excluded.status <> 'running' then excluded.finished_at end)`,
          lastActivityAt: sql`greatest(${t.lastActivityAt}, excluded.last_activity_at)`,
          progressDone: sql`case when ${t.status} <> 'running' or ${t.lastActivityAt} > excluded.last_activity_at then ${t.progressDone} else excluded.progress_done end`,
          progressTotal: sql`case when ${t.status} <> 'running' or ${t.lastActivityAt} > excluded.last_activity_at then ${t.progressTotal} else excluded.progress_total end`,
          eventsDropped: sql`greatest(${t.eventsDropped}, excluded.events_dropped)`,
          cycleId: sql`coalesce(excluded.cycle_id, ${t.cycleId})`,
          controlRequestId: sql`coalesce(excluded.control_request_id, ${t.controlRequestId})`,
          runId: sql`coalesce(excluded.run_id, ${t.runId})`, jobId: sql`coalesce(excluded.job_id, ${t.jobId})`,
          channelId: sql`coalesce(excluded.channel_id, ${t.channelId})`, queryId: sql`coalesce(excluded.query_id, ${t.queryId})`,
        },
      });
    }
    for (let i = 0; i < batch.events.length; i += batch.batchSize) {
      await tx.insert(activityEvents).values(batch.events.slice(i, i + batch.batchSize)).onConflictDoNothing({ target: activityEvents.id });
    }
    const touched = new Map<string, Date>();
    const touch = (id: string, at: Date): void => { if (!touched.has(id) || touched.get(id)!.getTime() < at.getTime()) touched.set(id, at); };
    for (const row of [...batch.roots, ...batch.spans]) touch(row.rootId, row.lastActivityAt);
    for (const event of batch.events) touch(event.rootId, event.at);
    for (const [id, at] of touched) {
      await tx.update(t).set({ lastActivityAt: sql`greatest(${t.lastActivityAt}, ${at.toISOString()}::timestamptz)` }).where(eq(t.id, id));
    }
  });
}

export async function closeStaleSpans(db: Db, options: { process: ActivityProcess; before: Date }): Promise<number> {
  const rows = await db.update(activitySpans).set({ status: "interrupted", finishedAt: sql`now()` })
    .where(and(eq(activitySpans.process, options.process), eq(activitySpans.status, "running"), sql`${activitySpans.startedAt} < ${options.before.toISOString()}::timestamptz`))
    .returning({ id: activitySpans.id });
  return rows.length;
}

export interface ActivityLiveness { staleAfterSeconds: number; startupGraceSeconds: number }

/** Shared by reconciliation, retention and the future read/delete paths. All time comparisons use database time. */
export function activeRootCondition(root: { [K in "id" | "scope" | "cycleId" | "controlRequestId" | "startedAt" | "status" | "process"]: SQLWrapper }, liveness: ActivityLiveness): SQL<boolean> {
  const condition = sql<boolean>`(
    (${root.scope} = 'cycle' and (
      exists (select 1 from cycles c where c.id = ${root.cycleId} and c.status = 'running')
      or exists (select 1 from control_requests cr where cr.kind = 'run_ai' and cr.status in ('pending', 'running')
        and cr.payload ->> 'cycleId' = ${root.cycleId}::text)
    ))
    or (${root.scope} = 'request'
      and exists (select 1 from control_requests cr where cr.id = ${root.controlRequestId} and cr.status in ('pending', 'running'))
      and not exists (select 1 from activity_spans newer where newer.scope = 'request' and newer.parent_id is null
        and newer.control_request_id = ${root.controlRequestId} and (newer.started_at, newer.id) > (${root.startedAt}, ${root.id}))
    )
    or (${root.scope} = 'system' and ${root.status} = 'running'
      and not exists (select 1 from activity_spans startup where startup.parent_id is null and startup.name = 'system.startup'
        and startup.process = ${root.process} and startup.started_at > ${root.startedAt})
      and case when exists (select 1 from runner_heartbeats hb where hb.process = ${root.process})
        then (select max(hb.at) from runner_heartbeats hb where hb.process = ${root.process}) >= now() - ${liveness.staleAfterSeconds} * interval '1 second'
        else ${root.startedAt} >= now() - ${liveness.startupGraceSeconds} * interval '1 second'
      end
    )
  )`;
  // Preserve correlated qualifiers when Drizzle renders this as a single-table SELECT field.
  // Its selection builder removes qualifiers from top-level Column chunks, but not nested SQL.
  return sql<boolean>`${condition}`;
}

export async function reconcileActivitySpans(db: Db, liveness: ActivityLiveness): Promise<number> {
  const root = alias(activitySpans, "activity_root");
  const rows = await db.execute<{ id: string }>(sql`
    with recursive protected_ai(id, root_id) as (
      select attempt.id, attempt.root_id from activity_spans attempt
      join activity_spans cycle_root on cycle_root.id = attempt.root_id and cycle_root.scope = 'cycle'
      join control_requests cr on cr.id = attempt.control_request_id
      where attempt.name = 'request.run_ai' and cr.kind = 'run_ai' and cr.status in ('pending', 'running')
        and cr.payload ->> 'cycleId' = cycle_root.cycle_id::text
        and not exists (select 1 from activity_spans newer where newer.name = 'request.run_ai'
          and newer.control_request_id = attempt.control_request_id
          and (newer.started_at, newer.id) > (attempt.started_at, attempt.id))
      union
      select child.id, child.root_id from activity_spans child
      join protected_ai parent on child.parent_id = parent.id and child.root_id = parent.root_id
      where child.name <> 'request.run_ai'
    )
    update ${activitySpans} set status = 'interrupted', reason_code = 'not_recorded', finished_at = now()
    where ${activitySpans.status} = 'running' and exists (
      select 1 from ${activitySpans} as ${root}
      where ${root.id} = ${activitySpans.rootId} and (
        (${root.scope} = 'cycle'
          and not exists (select 1 from cycles c where c.id = ${root.cycleId} and c.status = 'running')
          and not exists (select 1 from protected_ai live where live.id = ${activitySpans.id}))
        or (${root.scope} <> 'cycle' and not ${activeRootCondition(root, liveness)})
      )
    ) returning ${activitySpans.id}`);
  return rows.length;
}

export interface ActivityPruneOptions {
  days: number; maxEvents: number; batchSize: number; rootsPerBatch: number; liveness: ActivityLiveness;
}
export interface ActivityPruneBatch { roots: number; events: number; nextRootIds: string[] | null; found: boolean }

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function checkBatchOptions(batchSize: number, rootsPerBatch: number): void {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) throw new RangeError("invalid batch size");
  if (!Number.isSafeInteger(rootsPerBatch) || rootsPerBatch <= 0) throw new RangeError("invalid roots per batch");
}

/**
 * The root-selection predicates (activeRootCondition) are costly enough for the planner to JIT-compile them, which
 * takes longer than the whole batch; turn JIT off for this transaction only.
 */
async function withoutJit(tx: Tx): Promise<void> {
  await tx.execute(sql`set local jit = off`);
}

/**
 * Spend at most `budget` rows on the locked roots, in their given order: events first, then child spans of roots whose
 * events are gone, then the roots themselves once their trees are empty. Only root_id is a span FK; parent_id and
 * event.span_id deliberately have no FK, so keeping a root until last makes any child deletion order safe and avoids a
 * large final cascade.
 */
async function removeRootTrees(tx: Tx, rootIds: string[], budget: number): Promise<{ roots: number; events: number; left: string[] }> {
  const ordered = sql`unnest(array[${sql.join(rootIds.map((id) => sql`${id}`), sql`, `)}]::uuid[]) with ordinality as r(id, ord)`;
  const events = await tx.execute<{ id: string }>(sql`delete from activity_events where id in (
    select e.id from ${ordered} join activity_events e on e.root_id = r.id order by r.ord, e.at, e.id limit ${budget}
  ) returning id`);
  let left = budget - events.length;
  const removed = new Set<string>();
  if (left > 0) {
    const children = await tx.execute<{ id: string }>(sql`delete from activity_spans where id in (
      select s.id from ${ordered} join activity_spans s on s.root_id = r.id and s.id <> r.id
      where not exists (select 1 from activity_events e where e.root_id = r.id)
      order by r.ord, s.id limit ${left}
    ) returning id`);
    left -= children.length;
  }
  if (left > 0) {
    const roots = await tx.execute<{ id: string }>(sql`delete from activity_spans where id in (
      select r.id from ${ordered}
      where not exists (select 1 from activity_events e where e.root_id = r.id)
        and not exists (select 1 from activity_spans s where s.root_id = r.id and s.id <> r.id)
      order by r.ord limit ${left}
    ) returning id`);
    for (const row of roots) removed.add(row.id);
  }
  return { roots: removed.size, events: events.length, left: rootIds.filter((id) => !removed.has(id)) };
}

/**
 * Lock up to rootsPerBatch inactive roots (skipping roots another transaction holds) and delete at most batchSize rows
 * from them. Roots left unfinished are continued by id first, so a large tree is finished even if deleting part of it
 * brought the total below the cap. The FK and root locks serialize late writers.
 */
export async function pruneActivityBatch(db: Db, options: ActivityPruneOptions & { phase: "days" | "events"; rootIds?: string[] }): Promise<ActivityPruneBatch> {
  checkBatchOptions(options.batchSize, options.rootsPerBatch);
  return db.transaction(async (tx) => {
    await withoutJit(tx);
    const t = activitySpans;
    const lock = (candidate: SQL | undefined) => tx.select({ id: t.id }).from(t)
      .where(and(isNull(t.parentId), eq(t.id, t.rootId), sql`not ${activeRootCondition(t, options.liveness)}`, candidate))
      .orderBy(asc(t.lastActivityAt), asc(t.id)).limit(options.rootsPerBatch).for("update", { skipLocked: true });
    let ids = options.rootIds?.length ? (await lock(inArray(t.id, options.rootIds))).map((row) => row.id) : [];
    if (!ids.length && options.phase === "days") {
      ids = (await lock(sql`${t.lastActivityAt} < now() - ${options.days} * interval '1 day'`)).map((row) => row.id);
    } else if (!ids.length) {
      const [total] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from activity_events`);
      const excess = (total?.n ?? 0) - options.maxEvents;
      if (excess > 0) {
        // Take the oldest roots until their events cover the excess, so one batch does not overshoot the cap.
        const candidates = (await lock(undefined)).map((row) => row.id);
        const counts = candidates.length ? await tx.execute<{ id: string; n: number }>(sql`select r.id, (select count(*) from activity_events e where e.root_id = r.id)::int as n
          from unnest(array[${sql.join(candidates.map((id) => sql`${id}`), sql`, `)}]::uuid[]) with ordinality as r(id, ord) order by r.ord`) : [];
        let covered = 0;
        for (const row of counts) {
          if (covered >= excess) break;
          ids.push(row.id);
          covered += row.n;
        }
      }
    }
    if (!ids.length) return { roots: 0, events: 0, nextRootIds: null, found: false };
    const result = await removeRootTrees(tx, ids, options.batchSize);
    return { roots: result.roots, events: result.events, nextRootIds: result.left.length ? result.left : null, found: true };
  });
}

export async function pruneActivity(db: Db, options: ActivityPruneOptions & { deadlineForBatch?: (work: () => Promise<ActivityPruneBatch>) => Promise<ActivityPruneBatch> }): Promise<{ roots: number; events: number }> {
  const total = { roots: 0, events: 0 };
  for (const phase of ["days", "events"] as const) {
    let rootIds: string[] | undefined;
    while (true) {
      const work = () => pruneActivityBatch(db, { ...options, phase, rootIds });
      const batch = await (options.deadlineForBatch ? options.deadlineForBatch(work) : work());
      total.roots += batch.roots;
      total.events += batch.events;
      if (!batch.found) break;
      rootIds = batch.nextRootIds ?? undefined;
    }
  }
  return total;
}

export type ActivityDeleteScope =
  | { kind: "root"; rootId: string }
  | { kind: "range"; from: Date | null; to: Date }
  | { kind: "all" };
/** `blocked`: nothing was left to take, but eligible roots exist that another transaction (a prune, another delete) holds. */
export interface ActivityDeleteBatch { roots: number; events: number; found: boolean; blocked?: true }

/**
 * Lock up to rootsPerBatch eligible roots, newest first along activity_spans_roots_started_idx, skipping roots another
 * transaction holds, and spend the row budget on their events, children, then the roots. Only activity tables mutate.
 * When no root could be locked but eligible ones exist, the batch says `blocked`: they are not gone yet, so the caller
 * must not report the deletion as complete.
 */
export async function deleteActivityBatch(db: Db, options: {
  scope: ActivityDeleteScope; asOf: Date; liveness: ActivityLiveness; batchSize: number; rootsPerBatch: number;
}): Promise<ActivityDeleteBatch> {
  checkBatchOptions(options.batchSize, options.rootsPerBatch);
  return db.transaction(async (tx) => {
    await withoutJit(tx);
    const t = activitySpans;
    const { scope } = options;
    const candidate = scope.kind === "root" ? eq(t.id, scope.rootId) : scope.kind === "range"
      ? and(scope.from === null ? undefined : sql`${t.startedAt}>=${scope.from.toISOString()}::timestamptz`, sql`${t.startedAt}<${scope.to.toISOString()}::timestamptz`)
      : sql`true`;
    const eligible = and(
      isNull(t.parentId), eq(t.id, t.rootId), sql`${t.startedAt}<=${options.asOf.toISOString()}::timestamptz`,
      sql`not ${activeRootCondition(t, options.liveness)}`, candidate,
    );
    // nulls last: the order of activity_spans_roots_started_idx, which a plain desc (nulls first) cannot use
    const roots = await tx.select({ id: t.id }).from(t).where(eligible)
      .orderBy(sql`${t.startedAt} desc nulls last`, sql`${t.id} desc nulls last`).limit(options.rootsPerBatch).for("update", { skipLocked: true });
    if (!roots.length) {
      const [held] = await tx.select({ id: t.id }).from(t).where(eligible).limit(1);
      return held ? { roots: 0, events: 0, found: false, blocked: true } : { roots: 0, events: 0, found: false };
    }
    const result = await removeRootTrees(tx, roots.map((row) => row.id), options.batchSize);
    return { roots: result.roots, events: result.events, found: true };
  });
}

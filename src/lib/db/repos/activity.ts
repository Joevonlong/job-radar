import { and, asc, eq, inArray, isNull, ne, sql, type SQL, type SQLWrapper } from "drizzle-orm";
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
  days: number; maxEvents: number; batchSize: number; liveness: ActivityLiveness;
}
export interface ActivityPruneBatch { roots: number; events: number; nextRootId: string | null; found: boolean }

/**
 * Lock one root, delete at most batchSize rows (events, child spans, then the root). A large tree is continued by id
 * even if deleting its first batch brought the total below the cap. The FK and root lock serialize late writers.
 */
export async function pruneActivityBatch(db: Db, options: ActivityPruneOptions & { phase: "days" | "events"; rootId?: string }): Promise<ActivityPruneBatch> {
  return db.transaction(async (tx) => {
    const t = activitySpans;
    const candidate = options.rootId ? eq(t.id, options.rootId) : options.phase === "days"
      ? sql`${t.lastActivityAt} < now() - ${options.days} * interval '1 day'`
      : sql`(select count(*) from activity_events) > ${options.maxEvents}`;
    const [root] = await tx.select({ id: t.id }).from(t)
      .where(and(isNull(t.parentId), eq(t.id, t.rootId), sql`not ${activeRootCondition(t, options.liveness)}`, candidate))
      .orderBy(asc(t.lastActivityAt), asc(t.id)).limit(1).for("update");
    if (!root) return { roots: 0, events: 0, nextRootId: null, found: false };
    const ids = await tx.select({ id: activityEvents.id }).from(activityEvents).where(eq(activityEvents.rootId, root.id))
      .orderBy(asc(activityEvents.at), asc(activityEvents.id)).limit(options.batchSize);
    const deleted = ids.length ? await tx.delete(activityEvents).where(inArray(activityEvents.id, ids.map((row) => row.id))).returning({ id: activityEvents.id }) : [];
    const remaining = await tx.select({ id: activityEvents.id }).from(activityEvents).where(eq(activityEvents.rootId, root.id)).limit(1);
    if (remaining.length) return { roots: 0, events: deleted.length, nextRootId: root.id, found: true };
    const budget = options.batchSize - deleted.length;
    if (!budget) return { roots: 0, events: deleted.length, nextRootId: root.id, found: true };
    // Only root_id is a span FK; parent_id and event.span_id deliberately have no FK.
    // Keeping the locked root makes any child deletion order safe and avoids a large final cascade.
    const children = await tx.select({ id: t.id }).from(t).where(and(eq(t.rootId, root.id), ne(t.id, root.id)))
      .orderBy(asc(t.id)).limit(budget);
    if (children.length) await tx.delete(t).where(inArray(t.id, children.map((row) => row.id)));
    const remainingChildren = await tx.select({ id: t.id }).from(t).where(and(eq(t.rootId, root.id), ne(t.id, root.id))).limit(1);
    if (remainingChildren.length || children.length === budget) return { roots: 0, events: deleted.length, nextRootId: root.id, found: true };
    await tx.delete(t).where(eq(t.id, root.id));
    return { roots: 1, events: deleted.length, nextRootId: null, found: true };
  });
}

export async function pruneActivity(db: Db, options: ActivityPruneOptions & { deadlineForBatch?: (work: () => Promise<ActivityPruneBatch>) => Promise<ActivityPruneBatch> }): Promise<{ roots: number; events: number }> {
  const total = { roots: 0, events: 0 };
  for (const phase of ["days", "events"] as const) {
    let rootId: string | undefined;
    while (true) {
      const work = () => pruneActivityBatch(db, { ...options, phase, rootId });
      const batch = await (options.deadlineForBatch ? options.deadlineForBatch(work) : work());
      total.roots += batch.roots;
      total.events += batch.events;
      if (!batch.found) break;
      rootId = batch.nextRootId ?? undefined;
    }
  }
  return total;
}

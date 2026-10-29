/** Privacy boundary for activity views: explicit projections only, and compatibility codes for unknown enums. */
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { safeErrorCode } from "@/lib/activity/error-codes";
import { activityProcessSchema, eventCodeSchema, eventLevelSchema, spanNameSchema, spanScopeSchema, spanStatusSchema } from "@/lib/activity/names";
import { shortIdSchema, type ActivityParams } from "@/lib/activity/params";
import type { ActivityProcess, EventCode, EventLevel, SpanName, SpanScope, SpanStatus } from "@/lib/activity/types";
import { deliveryCountsSchema, type DeliveryDisposition } from "@/lib/channels/delivery";

import type { Db } from "../client";
import { activeRootCondition, type ActivityDeleteScope, type ActivityLiveness } from "../repos/activity";
import { activityEvents, activitySpans, companies, controlRequestKindEnum, controlRequestStatusEnum, jobs, runDeliveries, runs, runStatusEnum } from "../schema";

export type ActivityStatus = SpanStatus | "unknown";
export type ActivityName = SpanName | "unknown";
export type ActivityBusinessStatus = (typeof runStatusEnum.enumValues)[number] | "unknown";
export type ActivityRequestStatus = (typeof controlRequestStatusEnum.enumValues)[number] | "unknown";
export type ActivityRequestKind = (typeof controlRequestKindEnum.enumValues)[number] | "unknown";
export interface ActivityPage { page: number; pageSize: number }
export interface ActivityRootFilter {
  scope?: SpanScope; status?: "active" | "failed" | "partial";
  from?: Date; to?: Date; issuesOnly?: boolean;
}
export interface ActivityCurrentStep { name: ActivityName; progressDone: number | null; progressTotal: number | null }
export interface ActivityRootRow {
  id: string; scope: SpanScope | "unknown"; name: ActivityName; process: ActivityProcess | "unknown";
  status: ActivityStatus; reasonCode: string | null;
  startedAt: Date; finishedAt: Date | null; lastActivityAt: Date; durationMs: number | null;
  progressDone: number | null; progressTotal: number | null; eventsDropped: number;
  failedChildren: number; warnEvents: number; errorEvents: number; active: boolean;
  cycleId: number | null; cycleStatus: ActivityBusinessStatus | null;
  runAi: { status: ActivityRequestStatus } | null;
  controlRequestId: number | null;
  request: { kind: ActivityRequestKind; status: ActivityRequestStatus; errorCode: string | null } | null;
  isCurrentAttempt: boolean; latestHeartbeatAgeSeconds: number | null; newerStartup: boolean;
  currentStep: ActivityCurrentStep | null;
  currentSubtask: ActivityCurrentStep | null;
  /** DB-time observation and caller-provided thresholds allow pure display code to advance the clock. */
  observedAt: Date; liveness: ActivityLiveness;
}
export interface ActivitySpanRow {
  id: string; parentId: string | null; name: ActivityName; status: ActivityStatus; reasonCode: string | null;
  startedAt: Date; finishedAt: Date | null; durationMs: number | null;
  progressDone: number | null; progressTotal: number | null; eventsDropped: number;
  cycleId: number | null; controlRequestId: number | null; runId: number | null; jobId: number | null;
  jobExists: boolean; channelId: string | null; queryId: string | null;
  eventCounts: { info: number; warn: number; error: number };
}
export interface ActivityAttempt {
  id: string; rootId: string; startedAt: Date; status: ActivityStatus; isCurrent: boolean; requestCurrent: ActivityRequestStatus | null;
}
export interface ActivityStepDuration { name: ActivityName; status: ActivityStatus; durationMs: number | null }
export interface ActivityRootDetail {
  root: ActivityRootRow; spans: ActivitySpanRow[]; stepDurations: ActivityStepDuration[] | null; attempts: ActivityAttempt[];
}
export interface ActivityQueryRow {
  spanId: string; status: ActivityStatus; reasonCode: string | null;
  channelId: string | null; queryId: string | null; runId: number | null;
  run: { status: ActivityBusinessStatus; fetched: number; newCount: number; costUsd: number; errorCode: string | null } | null;
  delivery: { delivered: number; billedUnits: number; stored: number; dispositions: Partial<Record<DeliveryDisposition, number>> } | null;
  cascadeReasons: Record<string, string> | null;
}
export interface ActivityEventRow {
  id: string; spanId: string; at: Date; level: EventLevel | "unknown"; code: EventCode | "unknown";
  jobId: number | null; rawPostingId: number | null; params: ActivityParams;
  /** The sole free-text exception: job title and company, never description. Missing linked jobs keep exists=false. */
  job: { exists: boolean; title: string | null; company: string | null } | null;
}
export interface ActivityDeletePreview { asOf: Date; roots: number; events: number; skippedActive: number }

const businessStatusSchema = z.enum(runStatusEnum.enumValues);
const requestStatusSchema = z.enum(controlRequestStatusEnum.enumValues);
const requestKindSchema = z.enum(controlRequestKindEnum.enumValues);
function compatible<T>(schema: z.ZodType<T>, value: unknown): T | "unknown" {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
}
const reason = (value: string | null): string | null => value === null ? null : safeErrorCode(value);
const shortId = (value: string | null): string | null => value !== null && shortIdSchema.safeParse(value).success ? value : null;
const date = (value: Date | string): Date => value instanceof Date ? value : new Date(value);
const nullableDate = (value: Date | string | null): Date | null => value === null ? null : date(value);
function pagination(page: ActivityPage): { limit: number; offset: number } {
  z.object({ page: z.number().int().positive(), pageSize: z.number().int().positive() }).parse(page);
  return { limit: page.pageSize, offset: (page.page - 1) * page.pageSize };
}
/** Revalidate each scalar independently, so one legacy/bad value does not hide valid counters. */
function safeParams(value: unknown): ActivityParams {
  const result: ActivityParams = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [key, raw] of Object.entries(value)) {
    if (!shortIdSchema.safeParse(key).success) continue;
    const item = key === "error_code" ? safeErrorCode(raw) : raw;
    if ((typeof item === "number" && Number.isFinite(item)) || typeof item === "boolean" || shortIdSchema.safeParse(item).success) {
      result[key] = item as number | boolean | string;
    }
  }
  return result;
}

type RawRoot = Omit<ActivityRootRow, "scope" | "name" | "process" | "status" | "startedAt" | "finishedAt" | "lastActivityAt" | "observedAt" | "liveness" | "request" | "runAi" | "currentStep" | "currentSubtask" | "cycleStatus"> & {
  scope: string; name: string; process: string; status: string; cycleStatus: string | null;
  startedAt: Date | string; finishedAt: Date | string | null; lastActivityAt: Date | string; observedAt: Date | string;
  requestKind: string | null; requestStatus: string | null; requestErrorCode: string | null; runAiStatus: string | null;
  stepName: string | null; stepDone: number | null; stepTotal: number | null;
  subtaskName: string | null; subtaskDone: number | null; subtaskTotal: number | null;
};
function rootRow(row: RawRoot, liveness: ActivityLiveness): ActivityRootRow {
  return {
    id: row.id, scope: compatible(spanScopeSchema, row.scope), name: compatible(spanNameSchema, row.name),
    process: compatible(activityProcessSchema, row.process), status: compatible(spanStatusSchema, row.status), reasonCode: reason(row.reasonCode),
    startedAt: date(row.startedAt), finishedAt: nullableDate(row.finishedAt), lastActivityAt: date(row.lastActivityAt), durationMs: row.durationMs,
    progressDone: row.progressDone, progressTotal: row.progressTotal, eventsDropped: row.eventsDropped,
    failedChildren: row.failedChildren, warnEvents: row.warnEvents, errorEvents: row.errorEvents, active: row.active,
    cycleId: row.cycleId, cycleStatus: row.cycleStatus === null ? null : compatible(businessStatusSchema, row.cycleStatus),
    runAi: row.runAiStatus === null ? null : { status: compatible(requestStatusSchema, row.runAiStatus) },
    controlRequestId: row.controlRequestId,
    request: row.requestKind === null ? null : { kind: compatible(requestKindSchema, row.requestKind), status: compatible(requestStatusSchema, row.requestStatus), errorCode: reason(row.requestErrorCode) },
    isCurrentAttempt: row.isCurrentAttempt, latestHeartbeatAgeSeconds: row.latestHeartbeatAgeSeconds, newerStartup: row.newerStartup,
    currentStep: row.stepName === null ? null : { name: compatible(spanNameSchema, row.stepName), progressDone: row.stepDone, progressTotal: row.stepTotal },
    currentSubtask: row.subtaskName === null ? null : { name: compatible(spanNameSchema, row.subtaskName), progressDone: row.subtaskDone, progressTotal: row.subtaskTotal },
    observedAt: date(row.observedAt), liveness: { ...liveness },
  };
}
/** No business payload or error text enters this projection. All aggregates include the entire root tree. */
function rootsCte(liveness: ActivityLiveness, filter: ActivityRootFilter = {}): SQL {
  const root = alias(activitySpans, "r");
  const conditions: SQL[] = [sql`r.parent_id is null and r.id=r.root_id`];
  if (filter.scope) conditions.push(sql`r.scope=${filter.scope}`);
  if (filter.from) conditions.push(sql`r.started_at>=${filter.from.toISOString()}::timestamptz`);
  if (filter.to) conditions.push(sql`r.started_at<${filter.to.toISOString()}::timestamptz`);
  return sql`with summaries as (
    select r.id, r.scope, r.name, r.process, r.status, r.reason_code as "reasonCode",
      r.started_at as "startedAt", r.finished_at as "finishedAt", r.last_activity_at as "lastActivityAt",
      case when r.finished_at is not null then extract(epoch from (r.finished_at-r.started_at))*1000 end::float8 as "durationMs",
      r.progress_done as "progressDone", r.progress_total as "progressTotal",
      (select coalesce(sum(s.events_dropped),0)::integer from activity_spans s where s.root_id=r.id) as "eventsDropped",
      (select count(*)::integer from activity_spans s where s.root_id=r.id and s.id<>r.id and s.status in ('failed','interrupted')) as "failedChildren",
      (select count(*)::integer from activity_events e where e.root_id=r.id and e.level='warn') as "warnEvents",
      (select count(*)::integer from activity_events e where e.root_id=r.id and e.level='error') as "errorEvents",
      ${activeRootCondition(root, liveness)} as active,
      r.cycle_id::float8 as "cycleId", c.status as "cycleStatus", ai.status as "runAiStatus",
      r.control_request_id::float8 as "controlRequestId", cr.kind as "requestKind", cr.status as "requestStatus",
      cr.result ->> 'error' as "requestErrorCode",
      coalesce(attempt.rank=1,false) as "isCurrentAttempt",
      (select extract(epoch from (now()-max(hb.at)))::float8 from runner_heartbeats hb where hb.process=r.process) as "latestHeartbeatAgeSeconds",
      exists(select 1 from activity_spans startup where startup.parent_id is null and startup.name='system.startup'
        and startup.process=r.process and startup.started_at>r.started_at) as "newerStartup",
      step.name as "stepName", step.progress_done as "stepDone", step.progress_total as "stepTotal",
      subtask.name as "subtaskName", subtask.progress_done as "subtaskDone", subtask.progress_total as "subtaskTotal", now() as "observedAt"
    from activity_spans r
    left join cycles c on c.id=r.cycle_id
    left join control_requests cr on cr.id=r.control_request_id
    left join (select id, row_number() over (partition by control_request_id order by started_at desc,id desc) as rank
      from activity_spans where scope='request' and parent_id is null and id=root_id and control_request_id is not null) attempt on attempt.id=r.id
    left join lateral (select status from control_requests ai where ai.kind='run_ai' and ai.payload ->> 'cycleId'=r.cycle_id::text
      order by ai.requested_at desc,ai.id desc limit 1) ai on r.scope='cycle'
    left join lateral (select id,name,progress_done,progress_total from activity_spans s where s.root_id=r.id and s.name like 'step.%'
      and s.status='running' order by s.started_at desc,s.id desc limit 1) step on true
    left join lateral (select name,progress_done,progress_total from activity_spans s where s.root_id=r.id and s.parent_id=step.id
      and s.status='running' order by s.started_at desc,s.id desc limit 1) subtask on true
    where ${sql.join(conditions, sql` and `)}
  )`;
}
export async function listActivityRoots(db: Db, filter: ActivityRootFilter, page: ActivityPage, liveness: ActivityLiveness): Promise<{ rows: ActivityRootRow[]; total: number; anyActive: boolean }> {
  const { limit, offset } = pagination(page);
  const conditions: SQL[] = [sql`true`];
  if (filter.status === "active") conditions.push(sql`active`);
  if (filter.status === "failed") conditions.push(sql`(status in ('failed','interrupted') or "failedChildren">0)`);
  if (filter.status === "partial") conditions.push(sql`status='partial'`);
  if (filter.issuesOnly) conditions.push(sql`("warnEvents"+"errorEvents"+"failedChildren">0 or "eventsDropped">0)`);
  // Count separately from pagination so an empty/out-of-range page still returns its total and refresh flag.
  const where = sql.join(conditions, sql` and `);
  const rows = await db.execute<RawRoot>(sql`${rootsCte(liveness, filter)} select * from summaries where ${where} order by active desc,"startedAt" desc,id desc limit ${limit} offset ${offset}`);
  const [counts] = await db.execute<{ total: number; anyActive: boolean }>(sql`${rootsCte(liveness, filter)} select count(*)::integer as total,coalesce(bool_or(active),false) as "anyActive" from summaries where ${where}`);
  return { rows: rows.map((row) => rootRow(row, liveness)), total: counts.total, anyActive: counts.anyActive };
}

export async function getActivityRoot(db: Db, rootId: string, liveness: ActivityLiveness): Promise<ActivityRootDetail | null> {
  const [raw] = await db.execute<RawRoot>(sql`${rootsCte(liveness)} select * from summaries where id=${rootId}::uuid`);
  if (!raw) return null;
  const root = rootRow(raw, liveness);
  const t = activitySpans;
  const rows = await db.select({
    id: t.id, parentId: t.parentId, name: t.name, status: t.status, reasonCode: t.reasonCode,
    startedAt: t.startedAt, finishedAt: t.finishedAt,
    durationMs: sql<number | null>`case when ${t.finishedAt} is not null then extract(epoch from (${t.finishedAt}-${t.startedAt}))*1000 end::float8`,
    progressDone: t.progressDone, progressTotal: t.progressTotal, eventsDropped: t.eventsDropped,
    cycleId: t.cycleId, controlRequestId: t.controlRequestId, runId: t.runId, jobId: t.jobId, jobExists: sql<boolean>`${jobs.id} is not null`,
    channelId: t.channelId, queryId: t.queryId,
    info: sql<number>`(select count(*)::integer from activity_events e where e.span_id=${t.id} and e.root_id=${t.rootId} and e.level='info')`,
    warn: sql<number>`(select count(*)::integer from activity_events e where e.span_id=${t.id} and e.root_id=${t.rootId} and e.level='warn')`,
    error: sql<number>`(select count(*)::integer from activity_events e where e.span_id=${t.id} and e.root_id=${t.rootId} and e.level='error')`,
  }).from(t).leftJoin(jobs, eq(jobs.id, t.jobId)).where(eq(t.rootId, rootId)).orderBy(asc(t.startedAt), asc(t.id));
  const spans: ActivitySpanRow[] = rows.map(({ info, warn, error, ...row }) => ({ ...row,
    name: compatible(spanNameSchema, row.name), status: compatible(spanStatusSchema, row.status), reasonCode: reason(row.reasonCode),
    channelId: shortId(row.channelId), queryId: shortId(row.queryId), eventCounts: { info, warn, error },
  }));
  let stepDurations: ActivityStepDuration[] | null = null;
  if (root.scope === "cycle" && root.cycleId !== null) {
    const [summary] = await db.execute<{ present: boolean }>(sql`select summary_json is not null and summary_json <> 'null'::jsonb as present from cycles where id=${root.cycleId}`);
    if (summary?.present) {
      const steps = await db.execute<{ name: string | null; status: string | null; durationMs: number | null }>(sql`
        select step ->> 'name' as name,step ->> 'status' as status,
          case when jsonb_typeof(step -> 'durationMs')='number' then (step ->> 'durationMs')::float8 end as "durationMs"
        from cycles c cross join lateral jsonb_array_elements(case when jsonb_typeof(c.summary_json -> 'steps')='array'
          then c.summary_json -> 'steps' else '[]'::jsonb end) with ordinality as steps(step,ordinal)
        where c.id=${root.cycleId} order by ordinal`);
      stepDurations = steps.map((s) => ({ name: compatible(spanNameSchema, typeof s.name === "string" ? `step.${s.name}` : s.name),
        status: compatible(spanStatusSchema, s.status), durationMs: s.durationMs !== null && Number.isFinite(s.durationMs) ? s.durationMs : null }));
    }
  }
  // Detail includes the request root's attempts and each run_ai request represented inside a cycle tree.
  const requests = [...new Set(rows.filter((s) => (root.scope === "request" && s.id === root.id) || s.name === "request.run_ai").map((s) => s.controlRequestId).filter((id): id is number => id !== null))];
  const attempts: ActivityAttempt[] = [];
  for (const requestId of requests) {
    const requestRoot = root.scope === "request" && root.controlRequestId === requestId;
    const attemptRows = await db.execute<{ id: string; rootId: string; startedAt: Date | string; status: string; isCurrent: boolean; requestStatus: string | null }>(sql`
      select a.id,a.root_id as "rootId",a.started_at as "startedAt",a.status,cr.status as "requestStatus",
        row_number() over (order by a.started_at desc,a.id desc)=1 as "isCurrent"
      from activity_spans a left join control_requests cr on cr.id=a.control_request_id
      where a.control_request_id=${requestId} and ${requestRoot ? sql`a.scope='request' and a.parent_id is null and a.id=a.root_id` : sql`a.name='request.run_ai'`}
      order by a.started_at,a.id`);
    attempts.push(...attemptRows.map(({ requestStatus, ...a }) => ({ ...a, startedAt: date(a.startedAt), status: compatible(spanStatusSchema, a.status),
      requestCurrent: a.isCurrent && requestStatus !== null ? compatible(requestStatusSchema, requestStatus) : null })));
  }
  attempts.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id));
  return { root, spans, stepDurations, attempts };
}

export async function listQueryRows(db: Db, rootId: string): Promise<{ rows: ActivityQueryRow[]; queriesNotReached: number | null }> {
  const t = activitySpans;
  const rows = await db.select({ spanId: t.id, status: t.status, reasonCode: t.reasonCode, channelId: t.channelId, queryId: t.queryId, runId: t.runId,
    run: { id: runs.id, status: runs.status, fetched: runs.fetched, newCount: runs.newCount, costUsd: runs.cost, errorCode: runs.errorCode },
    delivery: { runId: runDeliveries.runId, delivered: runDeliveries.delivered, billedUnits: runDeliveries.billedUnits, counts: runDeliveries.countsJson },
    cascade: sql<unknown>`(select e.params from activity_events e where e.root_id=${t.rootId} and e.span_id=${t.id} and e.code='cascade_reasons' order by e.at desc,e.id desc limit 1)`,
  }).from(t).leftJoin(runs, eq(runs.id, t.runId)).leftJoin(runDeliveries, eq(runDeliveries.runId, runs.id))
    .where(and(eq(t.rootId, rootId), eq(t.name, "collect.query"))).orderBy(asc(t.startedAt), asc(t.id));
  const notes = await db.select({ params: activityEvents.params }).from(activityEvents).where(and(eq(activityEvents.rootId, rootId), eq(activityEvents.code, "queries_not_reached")));
  let queriesNotReached: number | null = null;
  for (const note of notes) {
    const count = safeParams(note.params).count;
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) queriesNotReached = (queriesNotReached ?? 0) + count;
  }
  return { rows: rows.map((row): ActivityQueryRow => {
    const counts = deliveryCountsSchema.safeParse(row.delivery?.counts);
    let cascadeReasons: Record<string, string> | null = null;
    if (row.cascade && typeof row.cascade === "object" && !Array.isArray(row.cascade)) {
      cascadeReasons = Object.fromEntries(Object.entries(row.cascade).filter(([key]) => shortIdSchema.safeParse(key).success).map(([key, code]) => [key, safeErrorCode(code)]));
    }
    return {
      spanId: row.spanId, status: compatible(spanStatusSchema, row.status), reasonCode: reason(row.reasonCode),
      channelId: shortId(row.channelId), queryId: shortId(row.queryId), runId: row.runId,
      run: row.run === null ? null : { status: compatible(businessStatusSchema, row.run.status), fetched: row.run.fetched, newCount: row.run.newCount, costUsd: row.run.costUsd, errorCode: reason(row.run.errorCode) },
      delivery: row.delivery && counts.success ? { delivered: row.delivery.delivered, billedUnits: row.delivery.billedUnits, stored: counts.data.dispositions.stored ?? 0, dispositions: counts.data.dispositions } : null,
      cascadeReasons,
    };
  }), queriesNotReached };
}

export async function listActivityEvents(db: Db, rootId: string, options: ActivityPage & { spanId?: string; level?: EventLevel }): Promise<{ rows: ActivityEventRow[]; total: number }> {
  const { limit, offset } = pagination(options);
  const e = activityEvents;
  const where = and(eq(e.rootId, rootId), options.spanId ? eq(e.spanId, options.spanId) : undefined, options.level ? eq(e.level, options.level) : undefined);
  const rows = await db.select({ id: e.id, spanId: e.spanId, at: e.at, level: e.level, code: e.code, jobId: e.jobId, rawPostingId: e.rawPostingId, params: e.params,
    existingJobId: jobs.id, title: jobs.title, company: companies.name,
  }).from(e).leftJoin(jobs, eq(jobs.id, e.jobId)).leftJoin(companies, eq(companies.id, jobs.companyId))
    .where(where).orderBy(asc(e.at), asc(e.id)).limit(limit).offset(offset);
  const [count] = await db.select({ total: sql<number>`count(*)::integer` }).from(e).where(where);
  return { rows: rows.map(({ existingJobId, title, company, ...row }) => ({ ...row,
    level: compatible(eventLevelSchema, row.level), code: compatible(eventCodeSchema, row.code), params: safeParams(row.params),
    job: row.jobId === null ? null : { exists: existingJobId !== null, title, company },
  })), total: count.total };
}

export async function previewActivityDelete(db: Db, scope: ActivityDeleteScope, liveness: ActivityLiveness): Promise<ActivityDeletePreview> {
  // One statement gives preview counts and cutoff a consistent database snapshot.
  const [row] = await db.execute<{ asOf: Date | string; roots: number; events: number; skippedActive: number }>(sql`
    ${rootsCte(liveness)} select date_trunc('milliseconds',now()) as "asOf",
      count(*) filter(where not active)::integer as roots,
      coalesce(sum((select count(*) from activity_events e where e.root_id=s.id)) filter(where not active),0)::integer as events,
      count(*) filter(where active)::integer as "skippedActive"
    from summaries s where s."startedAt"<=date_trunc('milliseconds',now()) and ${scope.kind === "root" ? sql`s.id=${scope.rootId}::uuid` : scope.kind === "range"
      ? sql`${scope.from === null ? sql`true` : sql`s."startedAt">=${scope.from.toISOString()}::timestamptz`} and s."startedAt"<${scope.to.toISOString()}::timestamptz` : sql`true`}`);
  return { ...row, asOf: date(row.asOf) };
}

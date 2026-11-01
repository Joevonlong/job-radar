import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";

import type { Db } from "../client";
import type { Executor } from "../executor";
import { controlRequests } from "../schema";

export type ControlRequest = typeof controlRequests.$inferSelect;
export type ControlRequestKind = ControlRequest["kind"];
export type ControlRequestStatus = ControlRequest["status"];

export const CONTROL_REQUEST_KINDS = ["run_cycle", "rescore_stale", "run_suggest", "run_ai", "translate_job", "breakdown_job", "score_jobs", "test_channel", "test_ai", "test_telegram", "salary_lookup", "writer_job"] as const satisfies readonly ControlRequestKind[];
/** The requests the settings page offers and lists; the AI ones belong to the ai-worker and show on /sources. */
export const SETTINGS_REQUEST_KINDS = ["run_cycle", "rescore_stale", "score_jobs"] as const satisfies readonly ControlRequestKind[];
/**
 * THE RULE: a request kind whose handler calls an AI provider is claimed only by the ai-worker on the
 * host (the container runner takes it only with `ai.yaml: execution: container`). Every new such kind (`run_suggest`,
 * `score_jobs`, ...) goes into this list, and into this list only: the claim lists of both
 * processes (`src/lib/control/kinds.ts`) and the `/sources` queue count derive from it.
 * `tests/ai-worker/units.test.ts` fails while a kind of the database enum is in neither list.
 */
export const AI_CONTROL_REQUEST_KINDS = ["run_ai", "translate_job", "breakdown_job", "rescore_stale", "run_suggest", "score_jobs", "test_ai", "salary_lookup", "writer_job"] as const satisfies readonly ControlRequestKind[];
/** User requests served independently of batch AI work. Automatic requests stay in the batch lane. */
export const INTERACTIVE_CONTROL_REQUEST_KINDS = ["translate_job", "breakdown_job", "salary_lookup", "test_ai", "writer_job"] as const satisfies readonly (typeof AI_CONTROL_REQUEST_KINDS)[number][];
/** The kinds that call no AI: the container runner's own work (the channel test and the Telegram test message). */
export const NON_AI_CONTROL_REQUEST_KINDS = ["run_cycle", "test_channel", "test_telegram"] as const satisfies readonly ControlRequestKind[];
/** The test buttons of /sources and /settings; their result is shown next to the button, not in the request list. */
export const TEST_CONTROL_REQUEST_KINDS = ["test_channel", "test_ai", "test_telegram"] as const satisfies readonly ControlRequestKind[];
/**
 * Kinds a restart does not put back in the queue. The test buttons: their result belongs next to a click, and a Telegram
 * test message sent again minutes later would surprise. `run_cycle`: the runner's catch-up already runs again the slot of a cycle a
 * restart cut off, and a queued manual cycle next to it would only collect twice; the "collect now" shows as failed and can be clicked again.
 * `salary_lookup`: a paid web search the user clicked; a restart must not run it (and bill it) again unasked, the card offers "try again".
 */
export const NOT_REQUEUED_CONTROL_REQUEST_KINDS = [...TEST_CONTROL_REQUEST_KINDS, "run_cycle", "salary_lookup"] as const satisfies readonly ControlRequestKind[];
/**
 * Kinds whose payload carries the user's own text (the material of an application answer). Every path that ends such a
 * request (done, failed, failed by a restart, expired) removes these keys from the payload in the same statement, so the
 * text lives in the table only while the request is open. What is left is what the request was about (job, question) and
 * the hash and reference ids the web put next to the text at queue time.
 */
export const SCRUBBED_PAYLOAD_KEYS = {
  writer_job: ["materials"],
} as const satisfies Partial<Record<ControlRequestKind, readonly string[]>>;
export type ScrubbedPayloadKind = keyof typeof SCRUBBED_PAYLOAD_KEYS;
export const SCRUBBED_PAYLOAD_KINDS = Object.keys(SCRUBBED_PAYLOAD_KEYS) as ScrubbedPayloadKind[];

export function isScrubbedPayloadKind(kind: ControlRequestKind): kind is ScrubbedPayloadKind {
  return Object.hasOwn(SCRUBBED_PAYLOAD_KEYS, kind);
}

/** The payload of a finished request of `kind`: the personal keys removed and `scrubbed: true` added; other kinds unchanged. */
export function scrubPayload(kind: ControlRequestKind, payload: unknown): unknown {
  if (!isScrubbedPayloadKind(kind)) return payload;
  const base = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? { ...(payload as Record<string, unknown>) } : {};
  for (const key of SCRUBBED_PAYLOAD_KEYS[kind]) delete base[key];
  return { ...base, scrubbed: true };
}

/**
 * The SQL twin of `scrubPayload` for an UPDATE of `control_requests`: `payload` with the personal keys of its row's kind
 * removed. The kind is compared as text, so the statement also runs before a migration has added a kind to the enum.
 */
function scrubbedPayloadSql(): SQL {
  const cases = SCRUBBED_PAYLOAD_KINDS.map((kind) => {
    const keys = sql.join(SCRUBBED_PAYLOAD_KEYS[kind].map((key) => sql`${key}::text`), sql`, `);
    return sql`when kind::text = ${kind}::text then (payload - array[${keys}]::text[]) || '{"scrubbed": true}'::jsonb`;
  });
  return sql`(case ${sql.join(cases, sql` `)} else payload end)`;
}

/** Statuses in which a request still waits for, or is held by, the runner. */
export const OPEN_CONTROL_STATUSES = ["pending", "running"] as const satisfies readonly ControlRequestStatus[];

export async function insertControlRequest(db: Executor, input: { kind: ControlRequestKind; payload?: unknown }): Promise<ControlRequest> {
  const [row] = await db
    .insert(controlRequests)
    .values({ kind: input.kind, payload: input.payload ?? {} })
    .returning();
  if (!row) throw new Error("insertControlRequest: insert returned no row");
  return row;
}

/** The oldest request of `kind` that is still pending or running, or null. */
export async function findOpenControlRequest(db: Db, kind: ControlRequestKind): Promise<ControlRequest | null> {
  const [row] = await db
    .select()
    .from(controlRequests)
    .where(and(eq(controlRequests.kind, kind), inArray(controlRequests.status, [...OPEN_CONTROL_STATUSES])))
    .orderBy(controlRequests.id)
    .limit(1);
  return row ?? null;
}

/** `('a'::control_request_kind, 'b'::control_request_kind)` for a `kind in (...)` test. */
function kindList(kinds: readonly ControlRequestKind[]): SQL {
  return sql.join(
    kinds.map((kind) => sql`${kind}::control_request_kind`),
    sql`, `,
  );
}

/** Every request of `kind` that is still pending or running, oldest first. */
export async function listOpenControlRequests(db: Executor, kind: ControlRequestKind): Promise<ControlRequest[]> {
  return db
    .select()
    .from(controlRequests)
    .where(and(eq(controlRequests.kind, kind), inArray(controlRequests.status, [...OPEN_CONTROL_STATUSES])))
    .orderBy(controlRequests.id);
}

/** Advisory lock key of queueing a `run_cycle` request (any constant; only this code takes it). */
export const RUN_CYCLE_QUEUE_LOCK = 118_002;

export type RunCycleQueueing =
  | { state: "queued"; row: ControlRequest }
  | { state: "existing"; row: ControlRequest }
  | { state: "busy" };

/**
 * Queue a `run_cycle` request: the open ones are read and the new row inserted in one transaction under an advisory lock,
 * so two requests at once never both see an empty queue. `exclusive` (a backfill): any open run_cycle refuses it (`busy`).
 * Otherwise `reuse` may pick an open request to join instead of inserting one.
 */
export async function queueRunCycleRequest(
  db: Executor,
  input: { payload: unknown; exclusive: boolean; reuse?: (open: readonly ControlRequest[]) => ControlRequest | undefined },
): Promise<RunCycleQueueing> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${RUN_CYCLE_QUEUE_LOCK})`);
    const open = await listOpenControlRequests(tx, "run_cycle");
    if (input.exclusive && open.length > 0) return { state: "busy" };
    const existing = input.reuse?.(open);
    if (existing) return { state: "existing", row: existing };
    return { state: "queued", row: await insertControlRequest(tx, { kind: "run_cycle", payload: input.payload }) };
  });
}

/**
 * A newer claimable run_ai holds back this run's job messages, without skipping any AI work. The final digest starts at
 * the oldest delegated cycle after the last delivered digest, so runs that deferred their push still count as new.
 * run_ai belongs to the batch lane; use the same lane-aware eligibility as claims and queue positions.
 * Match the whole payload against a cycle's valid request shape: malformed requests must not suppress a valid digest.
 */
export async function getRunAiNotificationWindow(db: Db, requestId: number): Promise<{ newerPending: boolean; startedAt: Date | null }> {
  const [row] = await db.execute<{ newer_pending: boolean; started_at: Date | string | null }>(sql`
    with delegated as (
      select r.id, r.kind, r.status, r.payload, c.id as cycle_id, c.started_at
      from control_requests r
      join cycles c on r.payload = jsonb_build_object('cycleId', c.id)
      where r.kind = 'run_ai'
    ), last_digest as (
      select coalesce(max(d.id), 0) as request_id
      from delegated d
      join notifications n on n.cycle_id = d.cycle_id or n.payload_json -> 'window' -> 'cycleIds' @> jsonb_build_array(d.cycle_id)
      where d.id < ${requestId} and n.kind = 'cycle_summary' and n.sent_at is not null
    )
    select
      exists(
        select 1 from delegated
        where id > ${requestId} and status = 'pending' ${claimableFilter(["run_ai"], "batch")}
      ) as newer_pending,
      (select min(started_at) from delegated where id <= ${requestId} and id > (select request_id from last_digest)) as started_at
  `);
  return { newerPending: row?.newer_pending ?? false, startedAt: row?.started_at ? new Date(row.started_at) : null };
}

/** The host worker splits interactive and batch work; the runner and --once keep one queue (`all`). */
export type ControlLane = "interactive" | "batch" | "all";

/** Pure counterpart of the SQL lane filter. Missing origin means user work, including older queued requests. */
export function controlLaneOf(kind: ControlRequestKind, payload: unknown): Exclude<ControlLane, "all"> {
  const auto = typeof payload === "object" && payload !== null && "origin" in payload && payload.origin === "auto";
  return (INTERACTIVE_CONTROL_REQUEST_KINDS as readonly ControlRequestKind[]).includes(kind) && !auto ? "interactive" : "batch";
}

/** `and kind in (...)` for `kinds` (nothing: every kind) and `lane`. Shared by the claim and the queue position. */
function laneFilter(kinds: readonly ControlRequestKind[] | undefined, lane: ControlLane): SQL {
  const kindFilter = kinds === undefined ? sql`` : sql`and kind in (${kindList(kinds)})`;
  const interactive = sql`(kind in (${kindList(INTERACTIVE_CONTROL_REQUEST_KINDS)}) and coalesce(payload ->> 'origin', '') <> 'auto')`;
  switch (lane) {
    case "interactive":
      return sql`${kindFilter} and ${interactive}`;
    case "batch":
      return sql`${kindFilter} and not ${interactive}`;
    case "all":
      return kindFilter;
  }
}

/**
 * The conditions under which a pending row may be claimed now (without `status = 'pending'` itself): its kind and lane,
 * and for a `run_ai` request a cycle that is no longer `running` (the cycle writes its own summary last).
 * One fragment shared by claims, queue positions and digest deferral.
 */
function claimableFilter(kinds: readonly ControlRequestKind[] | undefined, lane: ControlLane): SQL {
  return sql`${laneFilter(kinds, lane)}
        and not (
          kind = 'run_ai'
          and exists (select 1 from cycles c where c.id = nullif(payload ->> 'cycleId', '')::int and c.status = 'running')
        )`;
}

/**
 * Take the oldest pending request (of one of `kinds`, default every kind): it becomes `running` in the
 * same statement, so two runners (or two polls) can never take the same one (`for update skip locked`).
 * Null when nothing is pending. The runner and the ai-worker pass their own kinds, so neither takes
 * the other's work. A `run_ai` request is only claimable once the cycle it names is no longer `running`.
 */
export async function claimNextControlRequest(db: Db, kinds?: readonly ControlRequestKind[], options: { lane?: ControlLane } = {}): Promise<ControlRequest | null> {
  if (kinds !== undefined && kinds.length === 0) return null;
  const rows = await db.execute<Record<string, unknown>>(sql`
    update control_requests
    set status = 'running', started_at = now()
    where id = (
      select id from control_requests
      where status = 'pending' ${claimableFilter(kinds, options.lane ?? "all")}
      order by id
      for update skip locked
      limit 1
    )
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) return null;
  const [row] = await db
    .select()
    .from(controlRequests)
    .where(eq(controlRequests.id, Number(id)))
    .limit(1);
  return row ?? null;
}

/** Where one request stands in the queue of the process that claims it (see `describeControlQueue`). */
export interface ControlQueuePosition {
  /** Pending requests of the same queue that will be claimed before this one (claimable now, smaller id). */
  ahead: number;
  /** The other request of the same queue that has been running longest, or null when none runs. */
  running: { kind: ControlRequestKind; since: Date } | null;
  /** When this request was claimed (null while it is pending). */
  startedAt: Date | null;
}

/**
 * The queue position of request `requestId` among the requests of `kinds` (the claiming process's kinds) in `lane`. `ahead`
 * uses the claim's own filter (`claimableFilter`) plus `id < requestId`, so it counts what the claim takes first; a request
 * claimed meanwhile, or a `run_ai` whose cycle ends and that then goes first, makes it a snapshot. Null when there is no such request.
 */
export async function describeControlQueue(
  db: Db,
  input: { requestId: number; kinds: readonly ControlRequestKind[]; lane?: ControlLane },
): Promise<ControlQueuePosition | null> {
  const lane = input.lane ?? "all";
  const empty = input.kinds.length === 0;
  const rows = await db.execute<{ started_at: string | Date | null; ahead: number | string | null; running_kind: string | null; running_since: string | Date | null }>(sql`
    select
      r.started_at,
      ${empty ? sql`0` : sql`(select count(*)::int from control_requests where status = 'pending' and id < r.id ${claimableFilter(input.kinds, lane)})`} as ahead,
      run.kind::text as running_kind,
      run.started_at as running_since
    from control_requests r
    left join lateral (
      select kind, started_at from control_requests
      where ${empty ? sql`false` : sql`status = 'running' and id <> r.id ${laneFilter(input.kinds, lane)}`}
      order by started_at nulls last, id
      limit 1
    ) run on true
    where r.id = ${input.requestId}
  `);
  const row = rows[0];
  if (!row) return null;
  const date = (value: string | Date | null): Date | null => (value === null ? null : new Date(value));
  const since = date(row.running_since);
  const running = row.running_kind !== null && since !== null ? { kind: row.running_kind as ControlRequestKind, since } : null;
  return { ahead: Number(row.ahead ?? 0), running, startedAt: date(row.started_at) };
}

export async function finishControlRequest(
  db: Db,
  id: number,
  input: { status: Extract<ControlRequestStatus, "done" | "failed">; result?: unknown },
): Promise<ControlRequest | null> {
  const [row] = await db
    .update(controlRequests)
    .set({
      status: input.status,
      result: input.result ?? null,
      finishedAt: sql`now()`,
      payload: scrubbedPayloadSql(),
    })
    .where(eq(controlRequests.id, id))
    .returning();
  return row ?? null;
}

export interface RequeueOutcome {
  /** Put back to `pending`: the next start of the process takes them again. */
  requeued: number;
  /** Interrupted more often than allowed: failed with the reason. */
  failed: number;
}

/**
 * Requests still `running` whose process stopped under them (a deploy restarted it, it crashed) go back to
 * `pending`, so the work is picked up again instead of being lost; `result` keeps `{ interruptions, interrupted }`
 * meanwhile. A request interrupted `maxRequeues` times already fails with `reason` instead (a request that brings its
 * process down must not loop forever). `NOT_REQUEUED_CONTROL_REQUEST_KINDS` always fail. Only `running` rows of `kinds` (default every kind) are touched, and with `id` only
 * that one: a process passes its own kinds, so a restart of the runner never touches what the ai-worker is working on.
 */
export async function requeueInterruptedControlRequests(
  db: Db,
  input: { reason: string; maxRequeues: number; kinds?: readonly ControlRequestKind[]; id?: number },
): Promise<RequeueOutcome> {
  if (input.kinds !== undefined && input.kinds.length === 0) return { requeued: 0, failed: 0 };
  const kindFilter = input.kinds === undefined ? sql`` : sql`and kind in (${kindList(input.kinds)})`;
  const idFilter = input.id === undefined ? sql`` : sql`and id = ${input.id}`;
  const count = sql`(case when jsonb_typeof(result -> 'interruptions') = 'number' then (result ->> 'interruptions')::int else 0 end)`;
  const again = sql`(${count} < ${Math.max(0, input.maxRequeues)} and kind not in (${kindList(NOT_REQUEUED_CONTROL_REQUEST_KINDS)}))`;
  const rows = await db.execute<{ status: string }>(sql`
    update control_requests
    set status = case when ${again} then 'pending'::control_request_status else 'failed'::control_request_status end,
        started_at = case when ${again} then null else started_at end,
        finished_at = case when ${again} then null else now() end,
        result = case
          when ${again} then jsonb_build_object('interruptions', ${count} + 1, 'interrupted', ${input.reason}::text)
          else jsonb_build_object('error', ${input.reason}::text, 'interruptions', ${count})
        end,
        payload = case when ${again} then payload else ${scrubbedPayloadSql()} end
    where status = 'running' ${kindFilter} ${idFilter}
    returning status
  `);
  const requeued = rows.filter((row) => row.status === "pending").length;
  return { requeued, failed: rows.length - requeued };
}

/** The error code of a request that waited, or ran, longer than its kind allows (`failExpiredControlRequests`). */
export const EXPIRED_ERROR = "expired";

/**
 * Fail the requests of `kinds` that are pending longer than `olderThanSeconds` since they were queued, or running longer
 * than that since they were claimed: status `failed`, `result.error = "expired"`, and the payload scrubbed (for the
 * `SCRUBBED_PAYLOAD_KEYS` kinds), all in one UPDATE. Idempotent: the ai-worker before each poll, the runner at each cycle
 * and the web when it reads a request's state all call it, so an open request's text is cleared even while no worker
 * runs. Kinds are compared as text (a kind the enum does not have yet matches nothing). Returns the number of rows failed.
 */
export async function failExpiredControlRequests(db: Executor, input: { kinds: readonly ControlRequestKind[]; olderThanSeconds: number }): Promise<number> {
  if (input.kinds.length === 0) return 0;
  const kinds = sql.join(input.kinds.map((kind) => sql`${kind}::text`), sql`, `);
  const seconds = Math.max(1, Math.floor(input.olderThanSeconds));
  const rows = await db.execute<{ id: number }>(sql`
    update control_requests
    set status = 'failed'::control_request_status,
        finished_at = now(),
        result = jsonb_build_object('error', ${EXPIRED_ERROR}::text, 'stage', status::text),
        payload = ${scrubbedPayloadSql()}
    where kind::text in (${kinds})
      and (
        (status = 'pending' and requested_at < now() - make_interval(secs => ${seconds}))
        or (status = 'running' and coalesce(started_at, requested_at) < now() - make_interval(secs => ${seconds}))
      )
    returning id
  `);
  return rows.length;
}

export async function getControlRequest(db: Db, id: number): Promise<ControlRequest | null> {
  const [row] = await db.select().from(controlRequests).where(eq(controlRequests.id, id)).limit(1);
  return row ?? null;
}

/** Promote a pending automatic request without changing its id or touching work already claimed. */
export async function clearControlRequestOrigin(db: Db, id: number): Promise<boolean> {
  const rows = await db.update(controlRequests)
    .set({ payload: sql`${controlRequests.payload} - 'origin'` })
    .where(and(eq(controlRequests.id, id), eq(controlRequests.status, "pending"), sql`${controlRequests.payload} ->> 'origin' = 'auto'`))
    .returning({ id: controlRequests.id });
  return rows.length > 0;
}

/** Newest first; `kinds` limits the list to those kinds. */
export async function listControlRequests(db: Db, limit: number, kinds?: readonly ControlRequestKind[]): Promise<ControlRequest[]> {
  if (kinds !== undefined && kinds.length === 0) return [];
  return db
    .select()
    .from(controlRequests)
    .where(kinds === undefined ? undefined : inArray(controlRequests.kind, [...kinds]))
    .orderBy(desc(controlRequests.id))
    .limit(limit);
}

/** The oldest open `translate_job` request for one job, or null (a double click shares one request). */
export async function findOpenTranslateRequest(db: Db, jobId: number): Promise<ControlRequest | null> {
  return findOpenJobControlRequest(db, "translate_job", jobId);
}

/** The oldest open per-job request (`translate_job`, `breakdown_job`) for one job, or null. */
export async function findOpenJobControlRequest(db: Db, kind: "translate_job" | "breakdown_job", jobId: number): Promise<ControlRequest | null> {
  const [row] = await db
    .select()
    .from(controlRequests)
    .where(and(eq(controlRequests.kind, kind), inArray(controlRequests.status, [...OPEN_CONTROL_STATUSES]), sql`${controlRequests.payload} ->> 'jobId' = ${String(jobId)}`))
    .orderBy(controlRequests.id)
    .limit(1);
  return row ?? null;
}

/** The open (pending / running) per-job request of `kind` if there is one, else the newest finished one, or null: what the job page should show after a reload. */
export async function findLatestJobControlRequest(db: Db, kind: "translate_job" | "breakdown_job", jobId: number): Promise<ControlRequest | null> {
  const same = and(eq(controlRequests.kind, kind), sql`${controlRequests.payload} ->> 'jobId' = ${String(jobId)}`);
  const [open] = await db
    .select()
    .from(controlRequests)
    .where(and(same, inArray(controlRequests.status, [...OPEN_CONTROL_STATUSES])))
    .orderBy(desc(controlRequests.id))
    .limit(1);
  if (open) return open;
  const [latest] = await db.select().from(controlRequests).where(same).orderBy(desc(controlRequests.id)).limit(1);
  return latest ?? null;
}

/** The newest `writer_job` request of each question of the job (what the workbench resumes after a reload), by question id. */
export async function findLatestWriterRequests(db: Db, jobId: number): Promise<Map<number, ControlRequest>> {
  const rows = await db
    .selectDistinctOn([sql`${controlRequests.payload} ->> 'questionId'`])
    .from(controlRequests)
    .where(and(sql`${controlRequests.kind}::text = 'writer_job'`, sql`${controlRequests.payload} ->> 'jobId' = ${String(jobId)}`))
    .orderBy(sql`${controlRequests.payload} ->> 'questionId'`, desc(controlRequests.id));
  const out = new Map<number, ControlRequest>();
  for (const row of rows) {
    const questionId = Number((row.payload as { questionId?: unknown } | null)?.questionId);
    if (Number.isInteger(questionId)) out.set(questionId, row);
  }
  return out;
}

/** The open `writer_job` request of a question, or null. */
export async function findOpenWriterRequest(db: Db, input: { jobId: number; questionId: number }): Promise<ControlRequest | null> {
  const [row] = await db
    .select()
    .from(controlRequests)
    .where(and(
      sql`${controlRequests.kind}::text = 'writer_job'`,
      inArray(controlRequests.status, [...OPEN_CONTROL_STATUSES]),
      sql`${controlRequests.payload} ->> 'jobId' = ${String(input.jobId)}`,
      sql`${controlRequests.payload} ->> 'questionId' = ${String(input.questionId)}`,
    ))
    .orderBy(controlRequests.id)
    .limit(1);
  return row ?? null;
}

export interface OpenRequestStats {
  pending: number;
  running: number;
  /** Request time of the oldest request that is still pending (nothing has picked it up yet), or null. */
  oldestPendingAt: Date | null;
}

/** How many requests of `kinds` wait for, or are held by, their process. */
export async function countOpenControlRequests(db: Db, kinds: readonly ControlRequestKind[]): Promise<OpenRequestStats> {
  if (kinds.length === 0) return { pending: 0, running: 0, oldestPendingAt: null };
  const [row] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${controlRequests.status} = 'pending')::int`,
      running: sql<number>`count(*) filter (where ${controlRequests.status} = 'running')::int`,
      oldestPendingAt: sql<Date | null>`min(${controlRequests.requestedAt}) filter (where ${controlRequests.status} = 'pending')`,
    })
    .from(controlRequests)
    // Compared as text: `pnpm ops:drain` and the doctor run the new code before the deploy migrates, and a kind the enum does not
    // have yet (added by that migration) must match nothing instead of failing with "invalid input value for enum".
    .where(inArray(sql<string>`${controlRequests.kind}::text`, [...kinds]));
  return { pending: row?.pending ?? 0, running: row?.running ?? 0, oldestPendingAt: row?.oldestPendingAt ? new Date(row.oldestPendingAt) : null };
}

/** The newest request of `kind` that has finished (done or failed), or null. */
export async function getLatestFinishedControlRequest(db: Db, kind: ControlRequestKind): Promise<ControlRequest | null> {
  const [row] = await db
    .select()
    .from(controlRequests)
    .where(and(eq(controlRequests.kind, kind), inArray(controlRequests.status, ["done", "failed"])))
    .orderBy(desc(controlRequests.id))
    .limit(1);
  return row ?? null;
}

/** The newest request of `kind` (any status), or null: when the weekly suggestion was last asked for. */
export async function findLatestControlRequest(db: Db, kind: ControlRequestKind): Promise<ControlRequest | null> {
  const [row] = await db.select().from(controlRequests).where(eq(controlRequests.kind, kind)).orderBy(desc(controlRequests.id)).limit(1);
  return row ?? null;
}

import { z } from "zod";
import { loadConfig } from "@/lib/config/load";
import { watchConfig } from "@/lib/config/watch";
import type { ActivityLogConfig } from "@/lib/config/schemas/activity-log";
import type { Db } from "@/lib/db/client";
import type { openActivityConnection, writeActivityBatch } from "@/lib/db/repos/activity";

import { safeErrorCode } from "./error-codes";
import { createActivityFlusher } from "./flush";
import { newId, rootIdForCycle } from "./ids";
import { activityProcessSchema, eventCodeSchema, eventLevelSchema, spanNameSchema, spanStatusSchema } from "./names";
import { noopRecorder, noopSpan } from "./noop";
import { activityParamsSchema, businessIdSchema, spanLinksSchema } from "./params";
import type { ActivityBatch, ActivityEventWrite, ActivityProcess, ActivityRecorder, ActivitySpanWrite, EventCode, EventLevel, RequestSpanHandle, SpanHandle, SpanLinks, SpanName, SpanScope } from "./types";

export interface ActivityRecorderOptions {
  db: Db | null;
  process: ActivityProcess;
  now?: () => Date;
  onReenable?: () => void;
  loadSettings?: () => ActivityLogConfig;
  openConnection?: typeof openActivityConnection;
  writeBatch?: typeof writeActivityBatch;
  warn?: (line: string) => void;
  autoFlush?: boolean;
}
export interface ActivityInternals {
  process: ActivityProcess;
  startedAt: Date;
  settings(): ActivityLogConfig | undefined;
  subscribeSettings(listener: () => void): () => void;
  runMaintenance<T>(work: (db: Db) => Promise<T>): Promise<T | undefined>;
}
const internals = new WeakMap<ActivityRecorder, ActivityInternals>();
/** Internal lifecycle access; consumers only need the public recorder interface. */
export const activityInternals = (recorder: ActivityRecorder): ActivityInternals | undefined => internals.get(recorder);

interface Group { deferred: boolean; discarded: boolean }
interface State { row: ActivitySpanWrite; root: ActivitySpanWrite; placeholder: boolean; group: Group; captured: number }
interface QueuedEvent { row: ActivityEventWrite; owner: State }

/** Only safe class identifiers enter diagnostics, never arbitrary exception text. */
function errorClass(error: unknown): string {
  try {
    if (typeof error === "object" && error !== null) {
      if ("code" in error && typeof error.code === "string" && /^(?:[0-9A-Z]{5}|E[A-Z0-9_]{2,30})$/.test(error.code)) return error.code;
      if ("name" in error && error.name === "TimeoutError") return "timeout";
      if ("name" in error && typeof error.name === "string" && /^[A-Za-z]{1,40}Error$/.test(error.name)) return error.name;
    }
  } catch { /* Accessors on an unknown error may throw. */ }
  return "Error";
}

export function createActivityRecorder(options: ActivityRecorderOptions): ActivityRecorder {
  try { return buildRecorder(options); } catch { return noopRecorder; }
}

function buildRecorder(options: ActivityRecorderOptions): ActivityRecorder {
  if (options.db === null) return noopRecorder;
  const process = activityProcessSchema.parse(options.process);
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  let settings: ActivityLogConfig | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopColdWatcher: (() => void) | undefined;
  const settingsListeners = new Set<() => void>();
  let closing = false;
  let lastWarning = -Infinity;
  let coldWarning = false;
  let droppedEvents = 0;
  let droppedSpans = 0;
  let warningPending = false;
  const pending = new Map<string, State>();
  // Admission reserves room for every live handle, including between successful flushes.
  const admitted = new Map<string, State>();
  let events: QueuedEvent[] = [];
  let inFlight = new Map<string, State>();
  let inFlightEvents: QueuedEvent[] = [];

  const warn = (error: unknown): void => {
    try {
      const at = now();
      if (settings ? at.getTime() - lastWarning < settings.writer.warn_every_seconds * 1000 : coldWarning) return;
      if (!settings) coldWarning = true;
      lastWarning = at.getTime();
      (options.warn ?? console.warn)(`${at.toISOString()} [activity] ${errorClass(error)} events_dropped=${droppedEvents} spans_dropped=${droppedSpans}`);
    } catch { /* Even a broken diagnostic sink is isolated. */ }
  };
  const refresh = (): void => {
    try {
      const previous = settings;
      settings = structuredClone((options.loadSettings ?? (() => loadConfig("activityLog")))());
      stopColdWatcher?.(); stopColdWatcher = undefined;
      if ((previous ? !previous.enabled : coldWarning) && settings.enabled) {
        try { void Promise.resolve(options.onReenable?.()).catch(() => {}); } catch { /* Lifecycle callbacks are isolated. */ }
      }
      if (!closing && options.autoFlush !== false && previous?.writer.flush_ms !== settings.writer.flush_ms) {
        clearInterval(timer);
        timer = setInterval(() => { void flusher.flush(); }, settings.writer.flush_ms);
        timer.unref();
      }
      for (const listener of settingsListeners) { try { listener(); } catch { /* Internal scheduling stays isolated too. */ } }
      if (warningPending) { warningPending = false; warn(undefined); }
    } catch (error) {
      warn(error);
      if (!settings && !closing && options.autoFlush !== false && !stopColdWatcher) {
        // No valid writer cadence exists yet. Reuse config change detection until the file is repaired.
        try { stopColdWatcher = watchConfig("activityLog", () => { void flusher.flush(); }, { onError: warn }); } catch { /* Filesystem watchers are best effort. */ }
      }
    }
  };
  const safe = <T>(body: () => T, fallback: T): T => {
    try { return body(); } catch { return fallback; }
  };
  const enabled = (): boolean => !closing && settings?.enabled === true;
  const mark = (state: State): void => {
    if (!state.group.discarded && !closing) pending.set(state.row.id, state);
  };
  const drop = (state: State): void => {
    droppedEvents++;
    warningPending = true;
    state.row = { ...state.row, eventsDropped: state.row.eventsDropped + 1 };
    mark(state);
  };
  const size = (): number => new Set([...admitted.keys(), ...pending.keys(), ...inFlight.keys()]).size + events.length + inFlightEvents.length;
  const trim = (reserve = 0): void => {
    while (events.length && size() + reserve > (settings?.writer.queue_max ?? 0)) {
      const info = events.findIndex((event) => event.row.level === "info");
      const [removed] = events.splice(info < 0 ? 0 : info, 1);
      drop(removed.owner);
    }
  };
  const touch = (state: State): void => {
    state.row = { ...state.row, lastActivityAt: new Date(Math.max(state.row.lastActivityAt.getTime(), now().getTime())) };
    mark(state);
  };
  const enqueue = (state: State, level: EventLevel, code: EventCode, params: unknown, jobId?: number, rawPostingId?: number, errorCode?: string): void => {
    if (!enabled() || state.placeholder || state.group.discarded || state.row.status !== "running") return;
    const parsed = activityParamsSchema.safeParse(params ?? {});
    if (!parsed.success || !eventLevelSchema.safeParse(level).success || !eventCodeSchema.safeParse(code).success
      || (jobId !== undefined && !businessIdSchema.safeParse(jobId).success)
      || (rawPostingId !== undefined && !businessIdSchema.safeParse(rawPostingId).success)) { drop(state); return; }
    if (state.captured >= settings!.capture.max_events_per_span) { drop(state); return; }
    const safeParams = parsed.data;
    // The closed error code must also fit the params contract and occupies one of the twelve keys.
    if (errorCode !== undefined) safeParams.error_code = safeErrorCode(errorCode);
    if (!activityParamsSchema.safeParse(safeParams).success) { drop(state); return; }
    state.captured++;
    touch(state);
    events.push({ owner: state, row: { id: newId(), rootId: state.row.rootId, spanId: state.row.id, at: now(), level, code, params: safeParams, jobId: jobId ?? null, rawPostingId: rawPostingId ?? null } });
    trim();
  };
  const makeRow = (id: string, rootId: string, parentId: string | null, scope: SpanScope, name: SpanName, links: SpanLinks): ActivitySpanWrite => {
    const at = now();
    return {
      id, rootId, parentId, scope, name: spanNameSchema.parse(name), process, status: "running", reasonCode: null,
      startedAt: at, finishedAt: null, lastActivityAt: at, progressDone: null, progressTotal: null, eventsDropped: 0,
      cycleId: links.cycleId ?? null, controlRequestId: links.controlRequestId ?? null, runId: links.runId ?? null,
      jobId: links.jobId ?? null, channelId: links.channelId ?? null, queryId: links.queryId ?? null,
    };
  };
  const handle = (state: State, isRoot: boolean): RequestSpanHandle => ({
    id: state.row.id, rootId: state.row.rootId,
    child: (name, links) => safe(() => {
      if (!enabled() || state.group.discarded) return noopSpan;
      const checked = spanLinksSchema.parse(links ?? {});
      return create(makeRow(newId(), state.row.rootId, state.row.id, state.row.scope, name, { cycleId: state.row.cycleId ?? undefined, ...checked }), state.root, state.group);
    }, noopSpan),
    progress: (done, total) => { safe(() => {
      if (closing || state.placeholder || state.group.discarded || state.row.status !== "running") return;
      z.number().int().nonnegative().safe().parse(done);
      if (total !== undefined) z.number().int().nonnegative().safe().parse(total);
      state.row = { ...state.row, progressDone: done, progressTotal: total ?? state.row.progressTotal };
      touch(state); trim();
    }, undefined); },
    // Failed items are errors; pauses, skips and parse failures warn; successful items are info.
    item: (code, fields) => { safe(() => {
      if (!enabled() || state.placeholder || state.group.discarded || state.row.status !== "running") return;
      if (!["item.ok", "item.failed", "item.paused", "item.skipped", "parse_failed"].includes(code)) { if (enabled()) drop(state); return; }
      enqueue(state, code === "item.failed" ? "error" : code === "item.ok" ? "info" : "warn", code, fields?.params, fields?.jobId, fields?.rawPostingId, fields?.errorCode);
    }, undefined); },
    note: (level, code, params) => { safe(() => enqueue(state, level, code, params), undefined); },
    finish: (status, finishOptions) => { safe(() => {
      if (closing || state.placeholder || state.group.discarded || state.row.status !== "running") return;
      const terminal = spanStatusSchema.exclude(["running"]).parse(status);
      state.row = { ...state.row, status: terminal, finishedAt: now(), reasonCode: finishOptions?.reasonCode === undefined ? null : safeErrorCode(finishOptions.reasonCode) };
      if (isRoot) state.group.deferred = false;
      touch(state); trim();
    }, undefined); },
    discard: () => { safe(() => {
      if (!isRoot || !state.group.deferred) return;
      state.group.discarded = true;
      for (const [id, queued] of pending) if (queued.group === state.group) pending.delete(id);
      for (const [id, queued] of admitted) if (queued.group === state.group) admitted.delete(id);
      events = events.filter((event) => event.owner.group !== state.group);
    }, undefined); },
  });
  const create = (row: ActivitySpanWrite, root?: ActivitySpanWrite, group: Group = { deferred: false, discarded: false }, placeholder = false): RequestSpanHandle => {
    if (!enabled()) return noopSpan;
    const known = admitted.get(row.id) ?? pending.get(row.id) ?? inFlight.get(row.id);
    if (known) {
      if (!placeholder && known.placeholder) { known.row = row; known.root = row; known.placeholder = false; mark(known); }
      return handle(known, row.parentId === null);
    }
    trim(1);
    if (size() >= settings!.writer.queue_max) { droppedSpans++; warningPending = true; return noopSpan; }
    const state: State = { row, root: root ?? row, group, placeholder, captured: 0 };
    admitted.set(row.id, state);
    pending.set(row.id, state);
    return handle(state, row.parentId === null);
  };
  const take = (): ActivityBatch => {
    inFlight = new Map([...pending].filter(([, state]) => !state.group.deferred));
    for (const id of inFlight.keys()) pending.delete(id);
    inFlightEvents = events.filter((event) => !event.owner.group.deferred);
    events = events.filter((event) => event.owner.group.deferred);
    const roots = new Map<string, ActivitySpanWrite>();
    for (const state of inFlight.values()) roots.set(state.root.id, state.root);
    for (const event of inFlightEvents) roots.set(event.owner.root.id, event.owner.root);
    return { roots: [...roots.values()], spans: [...inFlight.values()].filter((state) => !state.placeholder).map((state) => state.row), events: inFlightEvents.map((event) => event.row), batchSize: settings!.writer.batch_size };
  };
  const settle = (_batch: ActivityBatch, outcome: "written" | "retry" | "not_ready"): void => {
    if (outcome === "retry") {
      for (const [id, state] of inFlight) if (!state.group.discarded) pending.set(id, state);
      events = [...inFlightEvents, ...events];
    } else if (outcome === "not_ready") {
      droppedSpans += inFlight.size;
      for (const event of inFlightEvents) {
        droppedEvents++;
        event.owner.row = { ...event.owner.row, eventsDropped: event.owner.row.eventsDropped + 1 };
      }
      // Keep counters on handles, but do not requeue a batch while the schema is absent.
    }
    if (outcome !== "retry") {
      for (const [id, state] of inFlight) {
        if (!pending.has(id) && (state.placeholder || state.row.status !== "running")) admitted.delete(id);
      }
    }
    inFlight = new Map();
    inFlightEvents = [];
    trim();
  };
  const flusher = createActivityFlusher({ db: options.db, now, warn, refresh, settings: () => settings, take, settle, openConnection: options.openConnection, writeBatch: options.writeBatch });
  const recorder: ActivityRecorder = {
    get enabled() { return settings?.enabled === true; },
    cycleRoot: (cycleId, links) => safe(() => {
      businessIdSchema.parse(cycleId);
      const checked = spanLinksSchema.parse({ cycleId, controlRequestId: links?.requestId });
      const id = rootIdForCycle(cycleId);
      return create(makeRow(id, id, null, "cycle", "cycle", checked));
    }, noopSpan),
    attachCycle: (cycleId) => safe(() => {
      businessIdSchema.parse(cycleId);
      const id = rootIdForCycle(cycleId);
      const result = create(makeRow(id, id, null, "cycle", "cycle", { cycleId }), undefined, undefined, true);
      // An attachment never updates a real root, even if this recorder has already created it.
      return { ...result, progress: () => {}, finish: () => {}, item: () => {}, note: () => {} } satisfies SpanHandle;
    }, noopSpan),
    requestRoot: (request, requestOptions) => safe(() => {
      const checked = spanLinksSchema.parse({ controlRequestId: request.id, jobId: requestOptions?.jobId });
      const name = spanNameSchema.parse(`request.${request.kind}`);
      const id = newId();
      return create(makeRow(id, id, null, "request", name, checked), undefined, { deferred: requestOptions?.deferred === true, discarded: false });
    }, noopSpan),
    systemRoot: (name, links) => safe(() => {
      if (!name.startsWith("system.")) return noopSpan;
      const id = newId();
      return create(makeRow(id, id, null, "system", name, spanLinksSchema.parse(links ?? {})));
    }, noopSpan),
    flush: flusher.flush,
    close: () => safe(() => { closing = true; clearInterval(timer); stopColdWatcher?.(); settingsListeners.clear(); return flusher.close(); }, Promise.resolve()),
  };
  internals.set(recorder, {
    process, startedAt, settings: () => settings, runMaintenance: flusher.runMaintenance,
    subscribeSettings(listener) { settingsListeners.add(listener); return () => { settingsListeners.delete(listener); }; },
  });
  refresh();
  return recorder;
}

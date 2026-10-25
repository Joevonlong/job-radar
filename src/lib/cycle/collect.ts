import { remoteScopeKey } from "@/lib/market/remote-scope";
import { CascadeController, type CascadeSpec, type UnavailableReason } from "@/lib/channels/cascade";
import { createChannelContext, createThrottle, httpSettingsFromConfig, NO_KNOWN_POSTINGS } from "@/lib/channels/context";
import { ChannelError, InfrastructureError, isAbortError, PartialCollectError, toChannelError } from "@/lib/channels/errors";
import { buildQueries, buildSweepQuery, capQuery } from "@/lib/channels/query";
import { orderQueries, rotationSummary, turnsOf, type RotationUnitSummary } from "@/lib/channels/rotation";
import {
  normalizedPostingDraftSchema,
  rawPostingInputSchema,
  type Channel,
  type KnownPostings,
  type RawPostingInput,
  type SearchQuery,
} from "@/lib/channels/types";
import type { Db } from "@/lib/db/client";
import { createRun, finishRun, getQueryRunHistory, type QueryRunHistoryRow, type RunStatus } from "@/lib/db/repos/runs";
import { getRawPayloadsByExternalId, upsertRawPostings } from "@/lib/db/repos/raw-postings";

import type { CycleStepContext, StepResult } from "./steps";

/** How many parsed titles a dry run shows per channel. */
const DRY_RUN_SAMPLE_TITLES = 3;
/** Longest error text stored in `runs.error`. */
const MAX_ERROR_CHARS = 500;

/** The channel's own rows of `raw_postings` as its "known postings". */
function createDbKnownPostings(db: Db, channelId: string): KnownPostings {
  return { payloads: (externalIds) => getRawPayloadsByExternalId(db, { channelIds: [channelId], externalIds }) };
}

export interface CollectChannelSummary {
  runs: number;
  succeeded: number;
  failed: number;
  skipped: number;
  /** Attempts that failed after some pages: their postings are stored, the failure counts like a failed attempt. */
  interrupted: number;
  fetched: number;
  inserted: number;
  changed: number;
  unchanged: number;
  costUsd: number;
  errorCodes: Record<string, number>;
}

export interface DryRunChannelReport {
  fetched: number;
  parsed: number;
  parseFailed: number;
  /** Titles of the first postings that parsed. */
  sampleTitles: string[];
}

/** One query as channels receive it (dry runs list them). */
export interface QueryPlanEntry {
  id: string;
  keywordGroup: string;
  location: string | null;
  remoteScope: string | null;
  windowHours: number;
  maxResults: number;
}

export interface ServedQuery {
  unit: string;
  queryId: string;
  /** The channel whose run answered the query; for `skipped`, null. */
  channelId: string | null;
  status: "served" | "failed" | "skipped";
}

export interface CollectResult {
  status: "succeeded" | "partial" | "failed";
  /** Distinct queries built for this cycle. */
  queries: number;
  channels: Record<string, CollectChannelSummary>;
  served: ServedQuery[];
  rotation: Record<string, RotationUnitSummary>;
  /** Channels given up on during the cycle (budget / non-retryable error), by error code. */
  unusable: Record<string, string>;
  /** Failures of the collect machinery itself (not of a channel). */
  errors: string[];
  aborted: boolean;
  dryRun?: Record<string, DryRunChannelReport>;
  /** Dry runs only: the distinct queries built for this cycle. */
  queryPlan?: QueryPlanEntry[];
}

interface Unit {
  /** Family name for cascades, channel id otherwise. */
  name: string;
  spec: CascadeSpec;
  familyChannels: readonly string[];
  queries: SearchQuery[];
}

const emptySummary = (): CollectChannelSummary => ({
  runs: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  interrupted: 0,
  fetched: 0,
  inserted: 0,
  changed: 0,
  unchanged: 0,
  costUsd: 0,
  errorCodes: {},
});

function truncate(text: string): string {
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

/** The error code all reasons of a skipped cascade share (budget_exceeded, or the code channels failed with), else null. */
function commonErrorCode(reasons: Record<string, string>): string | null {
  const codes = new Set(
    Object.values(reasons).map((reason) => (reason.startsWith("failed_this_cycle:") ? reason.slice("failed_this_cycle:".length) : reason === "budget_exceeded" ? reason : "")),
  );
  const [only] = codes;
  return codes.size === 1 && only ? only : null;
}

/** Run `fn` over `items` with at most `limit` in flight. `fn` must not throw. */
export async function mapWithConcurrency<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
}

/**
 * The `collect` step: run every enabled channel for the cycle's queries (C2: a channel's failure
 * stays inside its own runs). Channels run in parallel, up to `collect.concurrency`; the queries of
 * one channel — or of one cascade family — run sequentially with the channel's throttle between
 * them. Every (channel, query) attempt gets a `runs` row; postings go to `raw_postings` verbatim
 * (C1) before anything parses them. Dry runs do the same in memory and write nothing.
 */
export async function collectStep(ctx: CycleStepContext): Promise<StepResult> {
  const { config, channels: services } = ctx;
  const registry = services.registry;
  const isSelected = (id: string): boolean => services.selected === null || services.selected.includes(id);

  const summaries = new Map<string, CollectChannelSummary>();
  const summaryOf = (id: string): CollectChannelSummary => {
    const existing = summaries.get(id);
    if (existing) return existing;
    const created = emptySummary();
    summaries.set(id, created);
    return created;
  };
  const served: ServedQuery[] = [];
  const rotation: Record<string, RotationUnitSummary> = {};
  const errors: string[] = [];
  const dryRun: Record<string, DryRunChannelReport> = {};
  const unusable: Record<string, string> = {};
  const allQueries = new Map<string, SearchQuery>();
  let aborted = false;

  const keywordQueries = buildQueries(config.search, ctx.cycle.kind, { windowKind: ctx.windowKind });
  const sweepQuery = buildSweepQuery(config.search, ctx.cycle.kind, { windowKind: ctx.windowKind });

  /** A channel that is not due this cycle (a daily side channel that already ran) is left out; a failing check counts as due. */
  const isDue = async (channel: Channel): Promise<boolean> => {
    try {
      return (await channel.isDue?.({ kind: ctx.cycle.kind, now: ctx.now(), dryRun: ctx.dryRun })) ?? true;
    } catch (error) {
      ctx.logger.warn("channel due check failed; running it", { channel: channel.id, error: error instanceof Error ? error.message : "unknown error" });
      return true;
    }
  };

  // ---- work units: each cascade family is one unit, every other enabled channel its own
  const cascadeMembers = new Set(services.cascades.flatMap((c) => c.order));
  const units: Unit[] = [];
  const queriesFor = (order: readonly string[]): SearchQuery[] => {
    const first = order.map((id) => registry.get(id)).find((c): c is Channel => c !== undefined);
    return first && !first.usesQueries ? [sweepQuery] : keywordQueries;
  };
  for (const spec of services.cascades) {
    const order = spec.order.filter(isSelected);
    // a family none of whose channels exists in this process has nothing to run
    if (order.some((id) => registry.has(id))) units.push({ name: spec.family, spec: { family: spec.family, order }, familyChannels: spec.order, queries: queriesFor(order) });
  }
  for (const channel of registry.list()) {
    if (cascadeMembers.has(channel.id) || !isSelected(channel.id) || !registry.isEnabled(channel.id, config.channels)) continue;
    if (channel.isDue && !(await isDue(channel))) continue;
    const spec = { family: channel.family, order: [channel.id] };
    units.push({ name: channel.id, spec, familyChannels: [channel.id], queries: queriesFor(spec.order) });
  }
  for (const unit of units) for (const q of unit.queries) allQueries.set(q.id, q);

  let history: QueryRunHistoryRow[] = [];
  let historyReason: "dry_run" | "read_failed" | null = ctx.db ? null : "dry_run";
  if (ctx.db) {
    try {
      history = await getQueryRunHistory(ctx.db, {
        channelIds: [...new Set(units.flatMap((unit) => unit.familyChannels))],
        queryHashes: [...allQueries.keys()],
      });
    } catch (error) {
      historyReason = "read_failed";
      ctx.logger.warn("query history could not be read; using config order", { error: error instanceof Error ? error.message : "unknown error" });
    }
  }

  const requireDb = (): Db => {
    if (!ctx.db) throw new InfrastructureError("collect: database required for a non-dry run");
    return ctx.db;
  };

  const availability = async (id: string): Promise<UnavailableReason | null> => {
    const channel = registry.get(id);
    if (!channel) return "not_registered";
    if (!registry.isEnabled(id, config.channels)) return "disabled";
    if (channel.isConfigured && !channel.isConfigured()) return "not_configured";
    if (!services.budget.hasHeadroom(channel)) return "budget_exceeded";
    const circuit = await services.breaker.check(id);
    return circuit.allowed ? null : "circuit_open";
  };

  /** One collect call of `channel` for `query`, with its run row. Throws the (classified) failure. */
  const attempt = async (channelId: string, query: SearchQuery, attempted: Set<string>, recordWindow: (hours: number) => void): Promise<void> => {
    const channel = registry.get(channelId);
    const settings = registry.settingsFor(channelId, config.channels);
    if (!channel || !settings) throw new InfrastructureError(`collect: channel ${channelId} vanished from the registry`);
    const summary = summaryOf(channelId);

    // pace consecutive queries of the same channel
    if (attempted.has(channelId)) {
      await createThrottle({ settings, signal: ctx.signal, ...ctx.channels.runtime })();
    }
    attempted.add(channelId);

    const effective = capQuery(query, settings.maxResults);
    let runId: number | null = null;
    if (!ctx.dryRun) {
      try {
        runId = (await createRun(requireDb(), { channelId, cycleId: ctx.cycle.id, queryHash: query.id, windowHours: effective.windowHours, windowExtended: false })).id;
      } catch (error) {
        throw new InfrastructureError(`could not create run row for ${channelId}`, error);
      }
    }
    summary.runs += 1;

    const budget = services.budget.forChannel(channel);
    const channelContext = createChannelContext({
      channelId,
      settings,
      http: httpSettingsFromConfig(config.channels),
      budget,
      signal: ctx.signal,
      cycle: ctx.cycle,
      logger: ctx.logger,
      known: ctx.db ? createDbKnownPostings(ctx.db, channelId) : NO_KNOWN_POSTINGS,
      now: ctx.now,
      ...ctx.channels.runtime,
    });

    const finish = async (
      status: Exclude<RunStatus, "running">,
      fields: { fetched?: number; newCount?: number; error?: string | null; errorCode?: string | null; interrupted?: boolean },
    ): Promise<void> => {
      if (runId === null) return;
      try {
        await finishRun(requireDb(), runId, { status, cost: budget.attempt.usd, usageUnits: budget.attempt.records, ...fields });
      } catch (error) {
        throw new InfrastructureError(`could not finish run row ${runId}`, error);
      }
    };

    let collected: RawPostingInput[];
    /** Set when the query failed after some pages (`PartialCollectError`): their postings are stored first, then this is the failure. */
    let interrupted: ChannelError | null = null;
    /** The stop was the channel's own plan (its next request was refused by the channel's budget before it was sent), not a failure. */
    let plannedStop = false;
    try {
      recordWindow(effective.windowHours);
      const output: unknown = await channel.collect(effective, channelContext);
      if (!Array.isArray(output)) throw new ChannelError("parse", `${channelId}.collect did not return an array`);
      collected = output as RawPostingInput[];
    } catch (error) {
      if (isAbortError(error) || ctx.signal.aborted) {
        await finish("failed", { error: "cancelled" });
        throw error;
      }
      if (error instanceof PartialCollectError && error.postings.length > 0) {
        collected = [...error.postings];
        interrupted = error.cause;
        plannedStop = error.planned && error.cause.code === "budget_exceeded";
      } else {
        const failure = toChannelError(error);
        const skipped = failure.code === "budget_exceeded";
        summary.costUsd += budget.attempt.usd;
        if (skipped) summary.skipped += 1;
        else summary.failed += 1;
        summary.errorCodes[failure.code] = (summary.errorCodes[failure.code] ?? 0) + 1;
        await finish(skipped ? "skipped" : "failed", { error: truncate(failure.message), errorCode: failure.code });
        if (!skipped) await services.breaker.recordFailure(channelId, failure.code, { trips: failure.tripsCircuit });
        ctx.logger.warn("channel attempt failed", { channel: channelId, query: query.id, code: failure.code, retryable: failure.retryable });
        throw failure;
      }
    }

    // validate the boundary (C6); keep every valid record, flag the rest
    const valid: RawPostingInput[] = [];
    for (const record of collected) {
      const parsed = rawPostingInputSchema.safeParse(record);
      if (parsed.success) valid.push(parsed.data);
    }
    const invalid = collected.length - valid.length;

    // dry runs cannot know what is new: they report no inserts
    let counts = { inserted: 0, changed: 0, unchanged: 0 };
    if (!ctx.dryRun) {
      try {
        counts = await upsertRawPostings(requireDb(), {
          channelId,
          runId,
          items: valid.map((v) => ({ externalId: v.externalId, url: v.url, payload: v.payload })),
        });
      } catch (error) {
        await finish("failed", { fetched: collected.length, error: "could not store postings", errorCode: "unknown" }).catch(() => {});
        throw new InfrastructureError(`could not store postings of ${channelId}`, error);
      }
    } else {
      const report = (dryRun[channelId] ??= { fetched: 0, parsed: 0, parseFailed: 0, sampleTitles: [] });
      report.fetched += collected.length;
      for (const record of valid) {
        try {
          const draft = normalizedPostingDraftSchema.parse(channel.parse(record.payload));
          report.parsed += 1;
          if (report.sampleTitles.length < DRY_RUN_SAMPLE_TITLES) report.sampleTitles.push(draft.title);
        } catch {
          report.parseFailed += 1;
        }
      }
    }

    summary.fetched += collected.length;
    summary.inserted += counts.inserted;
    summary.changed += counts.changed;
    summary.unchanged += counts.unchanged;
    summary.costUsd += budget.attempt.usd;
    if (invalid > 0) summary.errorCodes.parse = (summary.errorCodes.parse ?? 0) + invalid;
    const rejected = invalid > 0 ? `${invalid} of ${collected.length} records rejected (invalid shape)` : null;

    if (interrupted && plannedStop) {
      // the postings are kept and the query is recorded like any other budget skip: no failure or interruption is counted, the circuit
      // is left alone, and the run is not a success either, so an incomplete set of keywords never counts as a complete visit of the channel
      summary.skipped += 1;
      summary.errorCodes.budget_exceeded = (summary.errorCodes.budget_exceeded ?? 0) + 1;
      const message = `budget reached after ${collected.length} postings: ${interrupted.message}${rejected ? `; ${rejected}` : ""}`;
      await finish("skipped", { fetched: collected.length, newCount: counts.inserted, error: truncate(message), errorCode: "budget_exceeded" });
      ctx.logger.info("channel attempt stopped by its budget", { channel: channelId, query: query.id, kept: collected.length });
      throw interrupted;
    }

    if (interrupted) {
      // the postings are kept; the failure itself is handled exactly as for a failed attempt (circuit, cascade, retry),
      // and the run is marked interrupted so readers never take it for a "some records invalid" partial
      summary.interrupted += 1;
      summary.errorCodes[interrupted.code] = (summary.errorCodes[interrupted.code] ?? 0) + 1;
      const message = `interrupted after ${collected.length} postings: ${interrupted.message}${rejected ? `; ${rejected}` : ""}`;
      await finish("partial", { fetched: collected.length, newCount: counts.inserted, error: truncate(message), errorCode: interrupted.code, interrupted: true });
      if (interrupted.code !== "budget_exceeded") await services.breaker.recordFailure(channelId, interrupted.code, { trips: interrupted.tripsCircuit });
      ctx.logger.warn("channel attempt interrupted", {
        channel: channelId,
        query: query.id,
        code: interrupted.code,
        retryable: interrupted.retryable,
        kept: collected.length,
      });
      throw interrupted;
    }

    summary.succeeded += 1;
    await finish(invalid > 0 ? "partial" : "succeeded", {
      fetched: collected.length,
      newCount: counts.inserted,
      ...(rejected ? { error: rejected, errorCode: "parse" } : {}),
    });
    // a channel that answered is healthy, even if some records were malformed
    await services.breaker.recordSuccess(channelId);
  };

  const runUnit = async (unit: Unit): Promise<void> => {
    const controller = new CascadeController(unit.spec, { availability });
    const attempted = new Set<string>();
    const now = ctx.now();
    const start = await controller.pick();
    const sortChannel = "channelId" in start ? start.channelId : null;
    const turns = sortChannel === null ? new Map<string, Date | null>() : turnsOf(history, sortChannel);
    const queries = sortChannel !== null && historyReason === null
      ? orderQueries(unit.queries, turns, config.channels.collect.query_rotation)
      : unit.queries;
    let reached = 0;
    let maxWindowHours: number | null = null;
    const recordWindow = (hours: number): void => { maxWindowHours = Math.max(maxWindowHours ?? hours, hours); };
    try {
      for (const [index, query] of queries.entries()) {
        ctx.signal.throwIfAborted();
        const outcome = await controller.serve((id) => attempt(id, query, attempted, recordWindow));
        if (outcome.status === "served") {
          reached += 1;
          served.push({ unit: unit.name, queryId: query.id, channelId: outcome.channelId, status: "served" });
        } else if (outcome.status === "failed") {
          reached += 1;
          served.push({ unit: unit.name, queryId: query.id, channelId: outcome.channelId, status: "failed" });
        } else {
          served.push({ unit: unit.name, queryId: query.id, channelId: null, status: "skipped" });
          await recordSkipped(unit, query, outcome.reasons, queries.length - index);
          break; // nothing can take the remaining queries this cycle
        }
      }
    } finally {
      for (const [id, code] of controller.unusableChannels()) unusable[id] = code;
    }
    const summary = rotationSummary({ queries: unit.queries, sortChannel, turns, reached, maxWindowHours, historyUnavailable: historyReason !== null, now });
    rotation[unit.name] = summary;
    ctx.logger.info("query rotation", { unit: unit.name, ...summary, notReached: summary.queries - reached, reason: historyReason ?? (sortChannel === null ? "no_start_channel" : null) });
  };

  /** All channels of a unit were unavailable: one skipped run row (on the first registered channel) says why. */
  const recordSkipped = async (unit: Unit, query: SearchQuery, reasons: Record<string, string>, remaining: number): Promise<void> => {
    const holder = unit.spec.order.find((id) => registry.has(id));
    const reason = truncate(
      `no available channel for ${unit.name} (${Object.entries(reasons)
        .map(([id, why]) => `${id}: ${why}`)
        .join(", ")}); ${remaining} quer${remaining === 1 ? "y" : "ies"} skipped`,
    );
    ctx.logger.warn("cascade has no available channel", { unit: unit.name, reasons, skippedQueries: remaining });
    if (holder === undefined) return;
    summaryOf(holder).skipped += 1;
    summaryOf(holder).runs += 1;
    if (ctx.dryRun) return;
    try {
      const run = await createRun(requireDb(), { channelId: holder, cycleId: ctx.cycle.id, queryHash: query.id });
      await finishRun(requireDb(), run.id, { status: "skipped", error: reason, errorCode: commonErrorCode(reasons) });
    } catch (error) {
      throw new InfrastructureError(`could not record skipped run for ${unit.name}`, error);
    }
  };

  await mapWithConcurrency(units, config.channels.collect.concurrency, async (unit) => {
    try {
      await runUnit(unit);
    } catch (error) {
      if (ctx.signal.aborted) {
        aborted = true;
        return;
      }
      const message = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
      errors.push(`${unit.name}: ${message}`.slice(0, MAX_ERROR_CHARS));
      ctx.logger.error("collect unit failed", { unit: unit.name, error: message });
    }
  });

  const totals = [...summaries.values()].reduce(
    // an interrupted attempt stored postings but is a failure of the channel: it never counts as a success here
    (acc, s) => ({ succeeded: acc.succeeded + s.succeeded, bad: acc.bad + s.failed + s.skipped + s.interrupted }),
    { succeeded: 0, bad: errors.length },
  );
  const status: CollectResult["status"] =
    totals.succeeded === 0 && totals.bad > 0 ? "failed" : totals.bad > 0 ? "partial" : "succeeded";

  const result: CollectResult = {
    status,
    queries: allQueries.size,
    channels: Object.fromEntries(summaries),
    served,
    rotation,
    unusable,
    errors,
    aborted,
    ...(ctx.dryRun
      ? {
          dryRun,
          queryPlan: [...allQueries.values()].map((q) => ({
            id: q.id,
            keywordGroup: q.keywordGroup,
            location: q.location,
            remoteScope: q.remoteScope === null ? null : remoteScopeKey(q.remoteScope),
            windowHours: q.windowHours,
            maxResults: q.maxResults,
          })),
        }
      : {}),
  };
  return { status: status === "succeeded" ? "ok" : status, result };
}

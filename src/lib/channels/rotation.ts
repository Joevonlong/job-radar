import type { QueryRunHistoryRow } from "@/lib/db/repos/runs";
import { remoteScopeKey } from "@/lib/market/remote-scope";

import type { SearchQuery } from "./types";

export interface QueryHistory {
  lastTurnAt: Date | null;
  lastCoveredAt: Date | null;
  firstSeenAt: Date | null;
}

/** Oldest turns first, unknowns before dates; ties keep config order. Never mutates the input. */
export function orderQueries<Q extends { readonly id: string }>(queries: readonly Q[], turns: ReadonlyMap<string, Date | null>, enabled: boolean): Q[] {
  const ordered = [...queries];
  const at = (query: Q): number => turns.get(query.id)?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (enabled) ordered.sort((a, b) => (at(a) === at(b) ? 0 : at(a) < at(b) ? -1 : 1));
  return ordered;
}

export function turnsOf(rows: readonly QueryRunHistoryRow[], channelId: string): Map<string, Date | null> {
  return new Map(rows.filter((row) => row.channelId === channelId).map((row) => [row.queryHash, row.lastTurnAt]));
}

/** Merge the full family's latest turn/coverage and earliest appearance. Sorting uses turnsOf, never this merge. */
export function familyHistory(rows: readonly QueryRunHistoryRow[], channelIds: readonly string[]): Map<string, QueryHistory> {
  const channels = new Set(channelIds);
  const history = new Map<string, QueryHistory>();
  for (const row of rows) {
    if (!channels.has(row.channelId)) continue;
    const value = history.get(row.queryHash) ?? { lastTurnAt: null, lastCoveredAt: null, firstSeenAt: null };
    if (row.lastTurnAt !== null && (value.lastTurnAt === null || row.lastTurnAt > value.lastTurnAt)) value.lastTurnAt = row.lastTurnAt;
    if (row.lastCoveredAt !== null && (value.lastCoveredAt === null || row.lastCoveredAt > value.lastCoveredAt)) value.lastCoveredAt = row.lastCoveredAt;
    if (value.firstSeenAt === null || row.firstSeenAt < value.firstSeenAt) value.firstSeenAt = row.firstSeenAt;
    history.set(row.queryHash, value);
  }
  return history;
}

/** Extend missed coverage only beyond tolerance, without shrinking the base window. */
export function catchUpWindow(input: {
  baseHours: number;
  anchor: Date | null;
  now: Date;
  maxCatchUpHours: number;
  toleranceHours: number;
  autoCatchUp: boolean;
}): { hours: number; capped: boolean } {
  const { baseHours, anchor, now, maxCatchUpHours, toleranceHours, autoCatchUp } = input;
  if (!autoCatchUp || anchor === null || maxCatchUpHours === 0) return { hours: baseHours, capped: false };
  const gap = Math.max(0, (now.getTime() - anchor.getTime()) / 3_600_000);
  if (gap <= baseHours + toleranceHours) return { hours: baseHours, capped: false };
  const roundedGap = Math.ceil(gap);
  const hours = Math.max(baseHours, Math.min(roundedGap, maxCatchUpHours));
  return { hours, capped: roundedGap > hours };
}

export interface RotationUnitSummary {
  sortChannel: string | null;
  queries: number;
  reached: number;
  neverRun: number;
  oldestWaitHours: number | null;
  oldestWaiting: { id: string; keywordGroup: string; location: string | null; remoteScope: string | null } | null;
  stretched: number;
  maxWindowHours: number | null;
  capped: number;
  historyUnavailable: boolean;
}

/** History is the snapshot at unit start; reached and the largest requested window describe this cycle. */
export function rotationSummary(input: {
  queries: readonly SearchQuery[];
  sortChannel: string | null;
  turns: ReadonlyMap<string, Date | null>;
  reached: number;
  stretched: number;
  capped: number;
  maxWindowHours: number | null;
  historyUnavailable: boolean;
  now: Date;
}): RotationUnitSummary {
  const { historyUnavailable } = input;
  let neverRun = 0;
  let oldest: { query: SearchQuery; at: Date } | null = null;
  // without a start channel nothing was ordered: only what the unit did is reported
  if (!historyUnavailable && input.sortChannel !== null) {
    for (const query of input.queries) {
      const at = input.turns.get(query.id);
      if (at == null) neverRun += 1;
      else if (oldest === null || at < oldest.at) oldest = { query, at };
    }
  }
  return {
    sortChannel: input.sortChannel,
    queries: input.queries.length,
    reached: input.reached,
    neverRun,
    oldestWaitHours: oldest === null ? null : Math.round((input.now.getTime() - oldest.at.getTime()) / 3_600_000 * 10) / 10,
    oldestWaiting: oldest === null ? null : {
      id: oldest.query.id,
      keywordGroup: oldest.query.keywordGroup,
      location: oldest.query.location,
      remoteScope: oldest.query.remoteScope === null ? null : remoteScopeKey(oldest.query.remoteScope),
    },
    stretched: input.stretched,
    maxWindowHours: input.maxWindowHours,
    capped: input.capped,
    historyUnavailable,
  };
}

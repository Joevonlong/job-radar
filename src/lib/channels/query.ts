import { createHash } from "node:crypto";

import type { SearchConfig } from "@/lib/config";
import type { CycleKind } from "@/lib/db/repos/cycles";

import { remoteScopeKey } from "@/lib/market/remote-scope";

import type { RemoteScope, SearchQuery } from "./types";

/** The cycle kinds that come from schedule.yaml (the others are `manual` and `catchup`). */
export type ScheduledCycleKind = Exclude<CycleKind, "manual" | "catchup">;

export function isScheduledKind(kind: CycleKind): kind is ScheduledCycleKind {
  return kind !== "manual" && kind !== "catchup";
}

/** Which `search.yaml: window_hours` key each scheduled kind uses. */
const WINDOW_KEY = {
  weekday_morning: "morning",
  weekday_evening: "evening",
  weekend: "weekend",
} as const satisfies Record<ScheduledCycleKind, keyof SearchConfig["window_hours"]>;

/** Keyword group id used for the keyword-less sweep of channels that iterate boards (ATS). */
export const SWEEP_GROUP = "*";

/** Stable id of a query: same keywords / location / remote flag ⇒ same id, whatever the cycle or limits. */
export function queryId(parts: {
  keywords: readonly string[];
  keywordGroup: string;
  location: string | null;
  remote: boolean;
  remoteScope: RemoteScope | null;
}): string {
  const canonical = JSON.stringify([parts.keywordGroup, [...parts.keywords].sort(), parts.location, parts.remote, parts.remoteScope === null ? null : remoteScopeKey(parts.remoteScope)]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Look-back window for a cycle. Scheduled kinds use their own window; a catch-up uses the window of
 * the cycle it replaces (`windowKind`); a manual run, or a catch-up without that information, looks
 * back as far as the longest configured window so nothing in between is missed.
 */
export function windowHoursFor(kind: CycleKind, search: SearchConfig, windowKind?: ScheduledCycleKind | null): number {
  const effective = isScheduledKind(kind) ? kind : windowKind;
  if (effective) return search.window_hours[WINDOW_KEY[effective]];
  return Math.max(...Object.values(search.window_hours));
}

/**
 * Queries of one cycle: every keyword group × every location, plus one remote query per group when
 * `remote_scope` is not `none`. Group and location order follow search.yaml.
 */
export function buildQueries(search: SearchConfig, kind: CycleKind, options: { windowKind?: ScheduledCycleKind | null } = {}): SearchQuery[] {
  const windowHours = windowHoursFor(kind, search, options.windowKind);
  const maxResults = search.max_per_group_per_location;
  const queries: SearchQuery[] = [];
  for (const [keywordGroup, keywords] of Object.entries(search.keyword_groups)) {
    const make = (location: string | null, remoteScope: RemoteScope | null): SearchQuery => ({
      id: queryId({ keywords, keywordGroup, location, remote: remoteScope !== null, remoteScope }),
      keywords: [...keywords],
      keywordGroup,
      location,
      remote: remoteScope !== null,
      remoteScope,
      windowHours,
      maxResults,
    });
    for (const location of search.locations) queries.push(make(location, null));
    if (search.remote_scope !== "none") queries.push(make(null, search.remote_scope));
  }
  return queries;
}

/** The single query handed to channels that ignore keywords (`usesQueries: false`): "everything on your boards". */
export function buildSweepQuery(search: SearchConfig, kind: CycleKind, options: { windowKind?: ScheduledCycleKind | null } = {}): SearchQuery {
  return {
    id: queryId({ keywords: [], keywordGroup: SWEEP_GROUP, location: null, remote: false, remoteScope: null }),
    keywords: [],
    keywordGroup: SWEEP_GROUP,
    location: null,
    remote: false,
    remoteScope: null,
    windowHours: windowHoursFor(kind, search, options.windowKind),
    maxResults: Number.MAX_SAFE_INTEGER,
  };
}

/** The query as a channel receives it: never asks for more than the channel's own `max_results`. */
export function capQuery(query: SearchQuery, channelMaxResults: number): SearchQuery {
  return query.maxResults <= channelMaxResults ? query : { ...query, maxResults: channelMaxResults };
}

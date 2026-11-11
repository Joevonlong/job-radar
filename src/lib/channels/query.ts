import { createHash } from "node:crypto";

import type { SearchConfig } from "@/lib/config";
import type { CycleKind } from "@/lib/db/repos/cycles";

import { placeGeo, plannedSearches, type PlaceGeo, type PlacePreferences } from "@/lib/market/places";
import { remoteScopeKey } from "@/lib/market/remote-scope";

import type { ChannelMarket } from "./market";
import type { Channel, ChannelRuntimeSettings, RemoteScope, SearchQuery } from "./types";
import type { WatchedCompanyBoard } from "@/lib/companies/watched-boards";

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
  company?: SearchQuery["company"];
}): string {
  const canonical = parts.company
    ? JSON.stringify(["company", parts.company.key])
    : JSON.stringify([parts.keywordGroup, [...parts.keywords].sort(), parts.location, parts.remote, parts.remoteScope === null ? null : remoteScopeKey(parts.remoteScope)]);
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

/** What the searches are made from: the location settings of preferences.yaml, read against the market's tables. */
export interface QueryPlaces {
  preferences: PlacePreferences & { workplace: readonly string[] };
  geo: PlaceGeo;
  home: { country: string; countryName: string };
}

export function queryPlaces(preferences: QueryPlaces["preferences"], pipeline: Parameters<typeof placeGeo>[0] & { market: { country: string; countryName: string } }): QueryPlaces {
  return { preferences, geo: placeGeo(pipeline), home: { country: pipeline.market.country, countryName: pipeline.market.countryName } };
}

/**
 * Queries of one cycle: every keyword group × every search of the location settings (see `plannedSearches`). Group order follows
 * search.yaml. `places` null (preferences.yaml cannot be read): no keyword queries, and the sweep and company queries still run.
 */
export function buildQueries(search: SearchConfig, places: QueryPlaces | null, kind: CycleKind, options: { windowKind?: ScheduledCycleKind | null } = {}): SearchQuery[] {
  if (places === null) return [];
  const windowHours = windowHoursFor(kind, search, options.windowKind);
  const maxResults = search.max_per_group_per_location;
  const planned = plannedSearches(places.preferences, places.geo, places.home);
  const queries: SearchQuery[] = [];
  for (const [keywordGroup, keywords] of Object.entries(search.keyword_groups)) {
    const seen = new Set<string>();
    for (const { location, remote, remoteScope, country } of planned) {
      const id = queryId({ keywords, keywordGroup, location, remote, remoteScope });
      if (seen.has(id)) continue;
      seen.add(id);
      queries.push({ id, keywords: [...keywords], keywordGroup, location, remote, remoteScope, country, windowHours, maxResults, company: null });
    }
  }
  return queries;
}

/** The texts the on-site searches use: the home city (or country) and the places I'd move to. Board discovery searches these only. */
export function onsiteSearchTexts(places: QueryPlaces): string[] {
  const texts = plannedSearches(places.preferences, places.geo, places.home).flatMap((search) => (search.remote || search.location === null ? [] : [search.location]));
  return texts.filter((text, index) => texts.findIndex((other) => other.toLowerCase() === text.toLowerCase()) === index);
}

/** A remote search that names a place rather than a scope. */
export function isRemotePlaceQuery(query: SearchQuery): boolean {
  return query.remote && query.location !== null;
}

/** A channel of a unit, with its settings when it is enabled and configured: only those take part in merging requests. */
export interface UnitChannel {
  channel: Pick<Channel, "supportsRemotePlaces" | "requestKey">;
  /** Null: the channel is off or not configured this cycle, so it sends nothing and does not keep two queries apart. */
  settings: ChannelRuntimeSettings | null;
}

function requestKeyOf({ channel, settings }: UnitChannel, query: SearchQuery): string {
  if (settings === null || channel.requestKey === undefined) return `id:${query.id}`;
  try {
    return channel.requestKey(query, settings);
  } catch {
    return `id:${query.id}`;
  }
}

/**
 * The queries of `queries` a unit of these channels runs, in one step:
 * - a board that sends no place on a remote query skips the ones naming a place (kept when any channel of the unit can send them);
 * - queries every active channel of the unit sends as the same request are one: the first is kept. A channel without `requestKey`
 *   keeps every query apart, so a cascade merges only what each of its enabled, configured members would send alike.
 */
export function queriesForChannels(queries: readonly SearchQuery[], channels: readonly UnitChannel[]): SearchQuery[] {
  const runnable = channels.some(({ channel }) => channel.supportsRemotePlaces !== false) ? [...queries] : queries.filter((query) => !isRemotePlaceQuery(query));
  const active = channels.filter((entry) => entry.settings !== null);
  if (active.length === 0) return runnable;
  const seen = new Set<string>();
  return runnable.filter((query) => {
    const key = JSON.stringify(active.map((entry) => requestKeyOf(entry, query)));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The request key of a board that reads a query's keywords, its kind and, on site, its place, and nothing of a remote scope or a country. */
export function placeFreeRequestKey(query: SearchQuery): string {
  const kind = searchKind(query);
  return JSON.stringify([kind, query.keywords, kind === "city" ? query.location : null, query.company?.key ?? null, query.windowHours, query.maxResults]);
}

/** `Amsterdam, Netherlands`: the place of a located query with its country, for boards that read both from one text. No known country, or the place is the country: the place alone. */
export function locatedText(query: Pick<SearchQuery, "location" | "country">, homeCountryName: string, market: Pick<ChannelMarket, "country" | "countryName" | "countries">): string | null {
  if (query.location === null || query.country === null) return query.location;
  const name = query.country === market.country ? homeCountryName : (market.countries.find((country) => country.code === query.country)?.name ?? query.country);
  const isTheCountry = [name, ...(query.country === market.country ? [market.countryName] : [])].some((text) => text.toLocaleLowerCase("en") === query.location?.toLocaleLowerCase("en"));
  return isTheCountry ? query.location : `${query.location}, ${name}`;
}

/** The country of a query outside the home country, for boards with a country field; null: their configured country applies. */
export function foreignCountry(query: Pick<SearchQuery, "country">, market: Pick<ChannelMarket, "country">): string | null {
  return query.country !== null && query.country !== market.country ? query.country : null;
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
    country: null,
    windowHours: windowHoursFor(kind, search, options.windowKind),
    maxResults: Number.MAX_SAFE_INTEGER,
    company: null,
  };
}

export function isCompanyQuery(query: SearchQuery): boolean {
  return query.company != null;
}

export function companyLabel(query: SearchQuery): string | null {
  return query.company?.name ?? null;
}

export function searchKind(query: SearchQuery): "city" | "remote" | "company" {
  return isCompanyQuery(query) ? "company" : query.remote ? "remote" : "city";
}

/** Nationwide company searches for watch-list entries without an enabled board. */
export function buildCompanyQueries(search: SearchConfig, companies: readonly WatchedCompanyBoard[], baseWindowHours: number): SearchQuery[] {
  if (!search.watched_company_queries.enabled) return [];
  const seen = new Set<string>();
  return companies.filter(({ key, hasBoard }) => {
    if (hasBoard || key === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(({ name, key }) => {
    const parts = { keywords: [name], keywordGroup: `company:${key}`, location: null, remote: false, remoteScope: null, company: { name, key } };
    return { ...parts, id: queryId(parts), country: null, windowHours: baseWindowHours, maxResults: search.watched_company_queries.max_results };
  });
}

/** The query as a channel receives it: never asks for more than the channel's own `max_results`. */
export function capQuery(query: SearchQuery, channelMaxResults: number): SearchQuery {
  return query.maxResults <= channelMaxResults ? query : { ...query, maxResults: channelMaxResults };
}

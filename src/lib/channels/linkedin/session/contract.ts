import { ChannelError } from "../../errors";
import type { ChannelMarket } from "../../market";
import type { SearchQuery } from "../../types";
import { sessionSettingsSchema, type SessionSettings } from "@/lib/config/schemas/channels";
import { remoteLocationFor } from "@/lib/market/remote-scope";
import { keywordStrings } from "../brightdata/contract";
import { searchKind } from "../../query";

/**
 * Contract of the LinkedIn session channels: ids, settings, and the URLs the channels open. The channels only
 * ever navigate (GET) to these pages in a browser that carries the user's own login state; nothing is clicked or typed.
 */

export const LINKEDIN_SESSION_ID = "linkedin-session";
/** The "recommended for you" side channel: once a day, not part of the cascade. */
export const LINKEDIN_SESSION_RECOMMENDED_ID = "linkedin-session:recommended";

export type { SessionSettings };

/** Validate the channel's config block (C6). Throws a non-retryable `ChannelError`. */
export function readSessionSettings(extra: unknown): SessionSettings {
  const parsed = sessionSettingsSchema.safeParse(extra);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join("."));
    throw new ChannelError("unknown", `sources.yaml linkedin.session is incomplete (${paths.join(", ")})`, { retryable: false });
  }
  return parsed.data;
}

/** LinkedIn's search pages hold this many results; `start=` moves by it. Not tunable: it is LinkedIn's page size. */
export const SEARCH_PAGE_SIZE = 25;

const SECONDS_PER_HOUR = 3600;

/** `https://www.linkedin.com/jobs/view/<id>/`: the id every LinkedIn channel dedupes on. */
export function jobUrl(baseUrl: string, jobId: string): string {
  return new URL(`/jobs/view/${jobId}/`, baseUrl).toString();
}

/** The location of a query: `City, Country`, or the configured location of the remote scope. */
export function locationOf(query: SearchQuery, settings: SessionSettings, market: ChannelMarket): string {
  if (searchKind(query) === "company") return settings.site.country_name || market.countryName;
  if (query.remote) return remoteLocationFor(query.remoteScope ?? "worldwide", settings.site.remote_locations, market);
  if (query.location === null) throw new Error("linkedin-session: a located query needs a location");
  return `${query.location}, ${settings.site.country_name || market.countryName}`;
}

/** The keyword strings of a query (`"A" OR "B"`, usually one). */
export function keywordPieces(query: SearchQuery): string[] {
  const pieces = keywordStrings(query.keywords);
  if (pieces.length === 0) throw new Error("linkedin-session: the query has no keywords");
  return pieces;
}

/**
 * One search result page. `f_TPR=r<seconds>` is LinkedIn's "date posted" filter (any number of seconds works), `f_WT=2` its
 * "remote" work type, `sortBy=DD` newest first. `start` is the result offset.
 */
export function searchUrl(query: SearchQuery, settings: SessionSettings, keywords: string, start: number, market: ChannelMarket): string {
  const url = new URL("/jobs/search/", settings.site.base_url);
  url.searchParams.set("keywords", keywords);
  url.searchParams.set("location", locationOf(query, settings, market));
  url.searchParams.set("f_TPR", `r${Math.max(1, Math.round(query.windowHours * SECONDS_PER_HOUR))}`);
  url.searchParams.set("sortBy", "DD");
  if (searchKind(query) === "remote") url.searchParams.set("f_WT", "2");
  if (start > 0) url.searchParams.set("start", String(start));
  return url.toString();
}

/** The "recommended for you" collection. */
export function recommendedUrl(settings: SessionSettings, start: number): string {
  const url = new URL("/jobs/collections/recommended/", settings.site.base_url);
  if (start > 0) url.searchParams.set("start", String(start));
  return url.toString();
}

/** The calendar day (`YYYY-MM-DD`) of `date` in `timeZone`: what the daily request limit counts in. */
export function dayKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string): string | undefined => parts.find((p) => p.type === type)?.value;
  const [year, month, day] = [get("year"), get("month"), get("day")];
  if (year === undefined || month === undefined || day === undefined) throw new Error(`dayKey: cannot format date for ${timeZone}`);
  return `${year}-${month}-${day}`;
}

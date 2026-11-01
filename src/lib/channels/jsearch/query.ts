import type { JsearchSettings } from "@/lib/config";

import { searchKind } from "../query";
import type { SearchQuery } from "../types";

/** `date_posted` values the API accepts, with the look-back they stand for. The API fixes both; they are not tunables. */
const DATE_POSTED: ReadonlyArray<readonly [value: "today" | "3days" | "week", hours: number]> = [
  ["today", 24],
  ["3days", 72],
  ["week", 168],
];

/** The smallest `date_posted` window that covers the look-back (`month` when it is longer than a week). */
export function datePostedFor(windowHours: number): "today" | "3days" | "week" | "month" {
  return DATE_POSTED.find(([, hours]) => windowHours <= hours)?.[0] ?? "month";
}

export interface JsearchRequest {
  /** Free-text search the way Google for Jobs reads it: `<keyword> in <city>`. */
  query: string;
  datePosted: ReturnType<typeof datePostedFor>;
  /** `work_from_home=true` (remote queries). */
  remote: boolean;
}

/**
 * The searches of one cycle query: the first `keywords_per_query` keywords of its group, each on its
 * own (Google for Jobs has no reliable OR), in the city, or as a remote search without one. A company query is one
 * request, `<company> in <home country>`, without the home-office filter; `homeCountryName` is the market's country name.
 */
export function buildRequests(query: SearchQuery, settings: Pick<JsearchSettings, "keywords_per_query">, homeCountryName?: string): JsearchRequest[] {
  const datePosted = datePostedFor(query.windowHours);
  if (searchKind(query) === "company") {
    if (!homeCountryName) throw new Error("jsearch: a company query needs the home country name");
    return query.keywords.slice(0, 1).map((name) => ({ query: `${name} in ${homeCountryName}`, datePosted, remote: false }));
  }
  const remote = query.remote || query.location === null;
  return query.keywords.slice(0, settings.keywords_per_query).map((keyword) => ({
    query: remote ? keyword : `${keyword} in ${query.location}`,
    datePosted,
    remote,
  }));
}

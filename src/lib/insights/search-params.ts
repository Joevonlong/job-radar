import { createLoader, parseAsInteger } from "nuqs/server";

/** URL state of /insights: the time range in days. Unknown values fall back to the configured default (see `resolveRangeDays`). */
export const insightsSearchParsers = {
  range: parseAsInteger,
};

export const loadInsightsSearchParams = createLoader(insightsSearchParsers);

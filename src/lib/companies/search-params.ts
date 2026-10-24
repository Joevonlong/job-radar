import { createLoader, createParser, createSerializer, parseAsStringLiteral, type inferParserType } from "nuqs/server";

import { MAX_FILTER_VALUE_CHARS, SORT_DIRS } from "@/lib/jobs/constants";

export const COMPANY_SORTS = ["jobs", "score", "recent"] as const;
export type CompanySort = (typeof COMPANY_SORTS)[number];

/** URL state shared by the company overview and its controls. Invalid values use the defaults. */
export const companiesSearchParsers = {
  q: createParser({
    parse: (value) => value.trim().slice(0, MAX_FILTER_VALUE_CHARS),
    serialize: (value) => value.trim().slice(0, MAX_FILTER_VALUE_CHARS),
  }).withDefault(""),
  sort: parseAsStringLiteral(COMPANY_SORTS).withDefault("jobs"),
  dir: parseAsStringLiteral(SORT_DIRS).withDefault("desc"),
  page: createParser({
    parse: (value) => {
      if (!/^\d+$/.test(value)) return null;
      const page = Number(value);
      return Number.isSafeInteger(page) && page > 0 ? page : null;
    },
    serialize: (value) => String(value),
  }).withDefault(1),
};

export type CompaniesSearchParams = inferParserType<typeof companiesSearchParsers>;
export const loadCompaniesSearchParams = createLoader(companiesSearchParsers);

const serializeParams = createSerializer(companiesSearchParsers);

/** Match Next's URLSearchParams encoding, as jobsListHref does, so link prefetches settle. */
export function serializeCompaniesParams(base: string, values: Partial<{ [K in keyof CompaniesSearchParams]: CompaniesSearchParams[K] | null }>): string {
  const url = serializeParams(base, values);
  const at = url.indexOf("?");
  if (at < 0) return url;
  const hashAt = url.indexOf("#", at);
  const query = new URLSearchParams(url.slice(at + 1, hashAt < 0 ? undefined : hashAt)).toString();
  const hash = hashAt < 0 ? "" : url.slice(hashAt);
  return `${url.slice(0, at)}${query ? `?${query}` : ""}${hash}`;
}

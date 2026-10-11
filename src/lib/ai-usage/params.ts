/** URL state of /sources/ai-usage: everything is validated here (C6); a bad value falls back to "not set". */
import { createLoader, createParser, parseAsInteger, parseAsStringLiteral } from "nuqs/server";

import { AI_PROVIDER_IDS } from "@/lib/config/ai-options";

import { AI_USAGE_RANGE_KINDS, isDay, type AiUsageRangeKind } from "./range";

export const AI_USAGE_METRICS = ["tokens", "equivalent", "calls"] as const;
export type AiUsageMetric = (typeof AI_USAGE_METRICS)[number];

const parseAsDay = createParser<string>({
  parse: (value) => (isDay(value) ? value : null),
  serialize: (value) => value,
});

const parseAsPattern = (pattern: RegExp) =>
  createParser<string>({
    parse: (value) => (pattern.test(value) ? value : null),
    serialize: (value) => value,
  });

export const aiUsageSearchParsers = {
  range: parseAsStringLiteral(AI_USAGE_RANGE_KINDS),
  from: parseAsDay,
  to: parseAsDay,
  provider: parseAsStringLiteral(AI_PROVIDER_IDS),
  model: parseAsPattern(/^\S{1,100}$/),
  task: parseAsPattern(/^[a-z_]{1,32}$/),
  metric: parseAsStringLiteral(AI_USAGE_METRICS),
  page: parseAsInteger,
};

export const loadAiUsageSearchParams = createLoader(aiUsageSearchParsers);

export interface AiUsageUrlState {
  range: AiUsageRangeKind | null;
  from: string | null;
  to: string | null;
  provider: string | null;
  model: string | null;
  task: string | null;
  metric: AiUsageMetric | null;
  page: number | null;
}

/** A page number the URL may carry: whole and at least 1. */
export function pageOf(state: Pick<AiUsageUrlState, "page">): number {
  return state.page !== null && Number.isInteger(state.page) && state.page >= 1 ? state.page : 1;
}

/**
 * `/sources/ai-usage?...` for `state` with `patch` applied. Only values that are set and not the default are written,
 * in a fixed order. The range is written whenever it is set (so "30 days" stays in the link even when it is the default).
 */
export function aiUsageHref(state: AiUsageUrlState, patch: Partial<AiUsageUrlState> = {}, base = "/sources/ai-usage"): string {
  const next = { ...state, ...patch };
  const params = new URLSearchParams();
  if (next.range !== null) params.set("range", next.range);
  if (next.range === "custom") {
    if (next.from !== null) params.set("from", next.from);
    if (next.to !== null) params.set("to", next.to);
  }
  if (next.provider !== null) params.set("provider", next.provider);
  if (next.model !== null) params.set("model", next.model);
  if (next.task !== null) params.set("task", next.task);
  if (next.metric !== null && next.metric !== "tokens") params.set("metric", next.metric);
  if (next.page !== null && next.page > 1) params.set("page", String(next.page));
  const query = params.toString();
  return query === "" ? base : `${base}?${query}`;
}

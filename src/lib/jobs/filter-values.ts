import { z } from "zod";

import type { MultiFilterKey } from "./filter-keys";
import { APPLICATION_FILTER_STATUSES, JOB_STATUSES, JOB_WORKPLACES, MAX_FILTER_VALUE_CHARS, MAX_FILTER_VALUES } from "./constants";

/**
 * One value of a multi-value filter, defined once: the /jobs URL parsers and the saved-view schema (interests.yaml)
 * both use it (C6). Free text values are trimmed and bounded; enum values are exact.
 */
export const filterText = z.string().trim().min(1).max(MAX_FILTER_VALUE_CHARS);

export const MULTI_VALUE_SCHEMAS = {
  source: filterText,
  city: filterText,
  contract: filterText,
  workplace: z.enum(JOB_WORKPLACES),
  status: z.enum(JOB_STATUSES),
  app: z.enum(APPLICATION_FILTER_STATUSES),
} as const;

export type MultiValue<K extends MultiFilterKey> = z.infer<(typeof MULTI_VALUE_SCHEMAS)[K]>;

/** Canonical order of the enum filters (`null`: free text keeps the order it was given in). */
export const MULTI_VALUE_ORDER: { readonly [K in MultiFilterKey]: readonly string[] | null } = {
  source: null,
  city: null,
  contract: null,
  workplace: JOB_WORKPLACES,
  status: JOB_STATUSES,
  app: APPLICATION_FILTER_STATUSES,
};

/** Put `values` of an enum filter in its canonical order; free text keeps its order. */
export function sortMultiValues<K extends MultiFilterKey>(key: K, values: readonly MultiValue<K>[]): MultiValue<K>[] {
  const order = MULTI_VALUE_ORDER[key];
  if (order === null) return [...values];
  return [...values].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** Drop invalid values, dedupe (first wins), sort enums canonically, cap at `MAX_FILTER_VALUES`. */
export function cleanMultiValues<K extends MultiFilterKey>(key: K, raw: readonly string[]): MultiValue<K>[] {
  const schema: z.ZodType<MultiValue<K>> = MULTI_VALUE_SCHEMAS[key] as unknown as z.ZodType<MultiValue<K>>;
  const seen = new Set<MultiValue<K>>();
  for (const item of raw) {
    const parsed = schema.safeParse(item);
    if (parsed.success) seen.add(parsed.data);
    if (seen.size >= MAX_FILTER_VALUES) break;
  }
  return sortMultiValues(key, [...seen]);
}

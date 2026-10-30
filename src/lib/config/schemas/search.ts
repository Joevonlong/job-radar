import { z } from "zod";

import { positiveInt, remoteScope, stringList } from "./common";

/** config/search.yaml — what to search for. */
export const searchSchema = z.strictObject({
  /** Keyword groups; each group is OR-merged into one query per location. */
  keyword_groups: z
    .record(z.string().regex(/^[a-z][a-z0-9_]*$/, "group id must be snake_case"), stringList.min(1))
    .refine((groups) => Object.keys(groups).length > 0, "needs at least one keyword group"),
  locations: stringList.min(1),
  remote_scope: remoteScope,
  /** Lookback window per cycle, in hours. Keys match the cycle kinds in schedule.yaml. */
  window_hours: z.strictObject({
    morning: positiveInt,
    evening: positiveInt,
    weekend: positiveInt,
  }),
  max_per_group_per_location: positiveInt,
  watched_company_queries: z.strictObject({
    enabled: z.boolean().default(true),
    max_per_cycle: z.int().min(0).max(20).default(3),
    min_interval_hours: z.int().min(1).max(720).default(24),
    max_results: z.int().min(1).max(100).default(25),
  }).prefault({}),
});

export type SearchConfig = z.infer<typeof searchSchema>;

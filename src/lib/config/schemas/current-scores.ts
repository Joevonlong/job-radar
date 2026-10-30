import { z } from "zod";

export const currentScoresSchema = z.strictObject({
  config_version: z.literal(1).optional(),
  backfill: z.strictObject({
    lock_timeout_ms: z.number().int().min(100).max(60000),
    statement_timeout_ms: z.number().int().min(1000).max(600000),
  }),
  refresh: z.strictObject({ lateral_max_jobs: z.number().int().min(1).max(100000) }),
});
export type CurrentScoresConfig = z.infer<typeof currentScoresSchema>;

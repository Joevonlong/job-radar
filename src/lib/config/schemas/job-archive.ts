import { z } from "zod";

export const jobArchiveSchema = z.strictObject({
  // The loader validates and strips the version before schema validation.
  config_version: z.literal(1).optional(),
  relist: z.strictObject({
    min_gap_days: z.number().int().min(0).max(3650),
    badge_days: z.number().int().min(1).max(365),
  }),
});

export type JobArchiveConfig = z.infer<typeof jobArchiveSchema>;

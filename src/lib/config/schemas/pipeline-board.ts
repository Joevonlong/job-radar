import { z } from "zod";

/** Display settings only. Every value is required; YAML is the source of defaults. */
export const pipelineBoardSchema = z.strictObject({
  // The layered loader validates and removes this metadata before schema validation.
  config_version: z.literal(1).optional(),
  density: z.strictObject({
    default: z.enum(["compact", "comfortable"]),
    remember_days: z.number().int().min(1).max(3650),
  }),
  compact: z.strictObject({
    title_lines: z.number().int().min(1).max(4),
    next_action_lines: z.number().int().min(1).max(3),
  }),
  layout: z.strictObject({
    column_min_width_rem: z.number().min(10).max(24),
    board_min_height_rem: z.number().min(12).max(60),
  }),
});

export type PipelineBoardConfig = z.infer<typeof pipelineBoardSchema>;

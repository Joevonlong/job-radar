import { z } from "zod";

import { BREAKDOWN_MODES } from "../breakdown-options";

import { positiveInt, score0to100 } from "./common";

/** config/breakdown.yaml: whether and when a JD is broken down by the AI. */
export const breakdownSchema = z.strictObject({
  /** false: no button on the job page, no automatic breakdown; stored results are still shown. */
  enabled: z.boolean(),
  /** manual: only on the button; auto: also the late AI sub-task of each cycle (see `auto`). */
  mode: z.enum(BREAKDOWN_MODES),
  auto: z.strictObject({
    /** Only jobs whose newest rank value reaches this (same scale as ai.yaml translate_auto_min_score). */
    min_rank: score0to100,
    /** Most jobs one cycle breaks down, best rank first. */
    per_cycle_limit: positiveInt,
  }),
  /** Longest JD (characters) sent to the model; a longer one keeps its beginning and its end. */
  jd_max_chars: positiveInt.min(500),
  /** Share of `jd_max_chars` taken from the beginning when a JD is cut. */
  jd_head_share: z.number().min(0.1).max(0.9),
  /** Time one provider gets for one breakdown (overrides its own timeout for this call). */
  timeout_seconds: positiveInt,
});
export type BreakdownConfig = z.infer<typeof breakdownSchema>;

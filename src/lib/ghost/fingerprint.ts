import { createHash } from "node:crypto";

import type { GhostRulesInput } from "./rules";

/**
 * Bump when the check changes in a way the packs and pipeline.yaml do not show (segmenting, the negation window, how points are
 * summed up): every job is checked again by the next cycles.
 */
export const GHOST_RULES_VERSION = 1;

/**
 * Hash of the packs' ghost section, the check's version and every limit that shapes a result (not `per_cycle_limit`): a change
 * checks every job again. The days a job has been open are not an input: the stored `recheck_at` brings a job back when it reaches
 * the next "open for long" tier.
 */
export function ghostRulesFingerprint(config: GhostRulesInput): string {
  const limits: Partial<GhostRulesInput["job_checks"]["ghost"]> = { ...config.job_checks.ghost };
  delete limits.per_cycle_limit;
  const relevant = { version: GHOST_RULES_VERSION, pack: config.ghost, limits };
  return createHash("sha256").update(JSON.stringify(relevant)).digest("hex").slice(0, 32);
}

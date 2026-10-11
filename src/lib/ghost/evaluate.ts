/**
 * The ghost job verdict of one job: the points of its reasons summed up into a level (pipeline.yaml `job_checks.ghost.levels`). Pure:
 * the cycle's check stores the result, `pnpm ghost:check` previews it. Only a hint: nothing here touches a score (C3).
 */
import type { CompiledGhostRules } from "./rules";
import { evergreenWording, longOpen, repostLabel, reposted, thinDescription, type EvergreenOptions } from "./signals";
import { GHOST_REASONS, NON_TIME_REASONS, type GhostInput, type GhostLevel, type GhostReason, type GhostResult } from "./types";

const NONE: GhostResult = { level: "none", score: 0, reasons: [], recheckAt: null };

/** The level of a sum of points; `likely` needs a reason that is not about time or length (else it stays `watch`). */
export function levelOf(score: number, reasons: readonly Pick<GhostReason, "code">[], levels: { watch: number; likely: number }): GhostLevel {
  if (score >= levels.likely && reasons.some((reason) => NON_TIME_REASONS.includes(reason.code))) return "likely";
  if (score >= levels.watch) return "watch";
  return "none";
}

export function evaluateGhost(input: GhostInput, rules: CompiledGhostRules, now: Date, options: EvergreenOptions = {}): GhostResult {
  // a company on the owner's trusted list is never flagged: no reasons are kept
  if (input.trustedCompany) return { ...NONE, reasons: [] };
  const open = longOpen(input, rules, now);
  const found: Array<GhostReason | null> = [
    open.reason,
    repostLabel(input.postings, rules),
    reposted(input.postings, rules),
    evergreenWording(input.description, rules, options),
    thinDescription(input, rules),
  ];
  const reasons = found.filter((reason): reason is GhostReason => reason !== null && reason.points > 0);
  reasons.sort((a, b) => GHOST_REASONS.indexOf(a.code) - GHOST_REASONS.indexOf(b.code));
  const score = reasons.reduce((sum, reason) => sum + reason.points, 0);
  return { level: levelOf(score, reasons, rules.settings.levels), score, reasons, recheckAt: open.recheckAt };
}

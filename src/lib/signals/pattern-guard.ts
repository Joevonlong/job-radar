/**
 * The server's probe for the user's interest patterns. interests.yaml `patterns`, `exclude` and `tag_patterns` are regular
 * expressions, and JavaScript has no time limit for them: one with catastrophic backtracking would hold the process on a
 * single description. So each pattern is tried first on long test texts in `vmTimeBox`, with the deal-breakers' probe and its
 * limits (pipeline.yaml `filter.deal_breakers`: `match_text_max_chars`, `match_ms`). Saving refuses a pattern that is too slow
 * there; a file edited by hand still reaches the rules, which then leave the pattern out (`signalPatternGuard`) with a
 * warning naming its category. Server code only (node:vm).
 */
import type { ChannelLogger } from "@/lib/channels/types";
import type { PipelineConfig } from "@/lib/config";
import { patternIsFast, type PatternProbeLimits, type TimeBox } from "@/lib/filter/deal-breakers";
import { vmTimeBox } from "@/lib/filter/time-box";

import type { SignalPatternGuard } from "./rules";

/** The probe's limits: the deal-breakers' (pipeline.yaml `filter.deal_breakers`). */
export const signalProbeLimits = (pipeline: Pick<PipelineConfig, "filter">): PatternProbeLimits => pipeline.filter.deal_breakers;

/**
 * Whether an interest pattern finishes on every test text within the limits (a fast pattern is remembered per process). A
 * pattern that fails is tried once more: a busy machine alone should not leave a working pattern out.
 */
export function signalPatternIsFast(limits: PatternProbeLimits, timeBox: TimeBox = vmTimeBox): (pattern: string) => boolean {
  return (pattern) => patternIsFast(pattern, "signal", limits, timeBox) || patternIsFast(pattern, "signal", limits, timeBox);
}

/**
 * The guard a run of the rules passes to `findCandidates`: a pattern that fails the probe is left out, with one warning per
 * compile (once per run and loaded config). Make one per run, so a run compiles the rules once.
 */
export function signalPatternGuard(limits: PatternProbeLimits, logger: Pick<ChannelLogger, "warn">, timeBox: TimeBox = vmTimeBox): SignalPatternGuard {
  return {
    isFast: signalPatternIsFast(limits, timeBox),
    onSlow: (slow) => logger.warn("interest pattern too slow on the test texts, left out", { category: slow.categoryId, field: slow.field, index: slow.index }),
  };
}

const shared = new WeakMap<PatternProbeLimits, SignalPatternGuard>();

/**
 * One guard per loaded limits object, for code that runs the rules once per request (the job page): the rules then
 * compile, probe and warn once per loaded config instead of on every request.
 */
export function sharedSignalPatternGuard(limits: PatternProbeLimits, logger: Pick<ChannelLogger, "warn">): SignalPatternGuard {
  const known = shared.get(limits);
  if (known) return known;
  const guard = signalPatternGuard(limits, logger);
  shared.set(limits, guard);
  return guard;
}

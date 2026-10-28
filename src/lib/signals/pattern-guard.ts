/**
 * The server's probe for the user's interest patterns. interests.yaml `patterns`, `exclude` and `tag_patterns` are regular
 * expressions, and JavaScript has no time limit for them: one with catastrophic backtracking would hold the process on a
 * single description. So each pattern is tried first on long test texts in `vmTimeBox` (the deal-breakers' probe, with the
 * limits of interests.yaml `limits`: `pattern_probe_chars`, `pattern_probe_ms`, `pattern_probe_retry_ms`). Saving refuses a
 * pattern that is too slow there; a file edited by hand still reaches the rules, which then leave the pattern out
 * (`signalPatternGuard`) with a warning naming its category. Server code only (node:vm).
 */
import type { ChannelLogger } from "@/lib/channels/types";
import type { InterestsConfig } from "@/lib/config";
import { patternIsFast, type TimeBox } from "@/lib/filter/deal-breakers";
import { vmTimeBox } from "@/lib/filter/time-box";

import type { SignalPatternGuard } from "./rules";

/** The limits the probe reads (interests.yaml `limits`). */
export type SignalProbeLimits = Pick<InterestsConfig["limits"], "pattern_probe_chars" | "pattern_probe_ms" | "pattern_probe_retry_ms">;

/**
 * The verdict for each pattern and limits, kept for the life of the process. A pattern near the limit would otherwise be fast
 * in one cycle and slow in the next, and each change makes every job be scanned (and reviewed by the AI) again. A changed
 * pattern or limit is a new key, so editing the file is judged afresh. The oldest verdict goes when the map is full.
 */
const verdicts = new Map<string, boolean>();
/** Enough for every pattern the schema allows several times over (a cache size, not a limit of the rules). */
const VERDICTS_MAX = 4096;

/**
 * Whether an interest pattern finishes on every test text within `pattern_probe_ms`. A pattern that does not is tried once
 * more with the larger `pattern_probe_retry_ms`: a busy machine makes a normal pattern a few times slower, while catastrophic
 * backtracking is slower by orders of magnitude, so only the second failure counts.
 */
export function signalPatternIsFast(limits: SignalProbeLimits, timeBox: TimeBox = vmTimeBox): (pattern: string) => boolean {
  const first = { match_text_max_chars: limits.pattern_probe_chars, match_ms: limits.pattern_probe_ms };
  const retry = { match_text_max_chars: limits.pattern_probe_chars, match_ms: limits.pattern_probe_retry_ms };
  return (pattern) => {
    const key = `${first.match_text_max_chars}\u0000${first.match_ms}\u0000${retry.match_ms}\u0000${pattern}`;
    const known = verdicts.get(key);
    if (known !== undefined) return known;
    const fast = patternIsFast(pattern, "signal", first, timeBox) || patternIsFast(pattern, "signal", retry, timeBox);
    if (verdicts.size >= VERDICTS_MAX) verdicts.delete(verdicts.keys().next().value ?? "");
    verdicts.set(key, fast);
    return fast;
  };
}

/**
 * The guard a run of the rules passes to `findCandidates`: a pattern that fails the probe is left out, with one warning per
 * compile (once per run and loaded config). Make one per run, so a run compiles the rules once.
 */
export function signalPatternGuard(limits: SignalProbeLimits, logger: Pick<ChannelLogger, "warn">, timeBox: TimeBox = vmTimeBox): SignalPatternGuard {
  return {
    isFast: signalPatternIsFast(limits, timeBox),
    onSlow: (slow) => logger.warn("interest pattern too slow on the test texts, left out", { category: slow.categoryId, field: slow.field, index: slow.index }),
  };
}

const shared = new WeakMap<SignalProbeLimits, SignalPatternGuard>();

/**
 * One guard per loaded limits object (interests.yaml `limits`), for code that runs the rules once per request (the job page):
 * the rules then compile, probe and warn once per loaded config instead of on every request.
 */
export function sharedSignalPatternGuard(limits: SignalProbeLimits, logger: Pick<ChannelLogger, "warn">): SignalPatternGuard {
  const known = shared.get(limits);
  if (known) return known;
  const guard = signalPatternGuard(limits, logger);
  shared.set(limits, guard);
  return guard;
}

/**
 * Run `work` (the rules on one job description) in `vmTimeBox` for at most `limits.pattern_job_ms`: false when it was
 * stopped. The backstop for a pattern that passes the probe but is slow on one real text. Compile the rules before (a probe
 * inside this box would run without its own limit).
 */
export function withinJobBudget(work: () => void, limits: Pick<InterestsConfig["limits"], "pattern_job_ms">, timeBox: TimeBox = vmTimeBox): boolean {
  return timeBox(work, limits.pattern_job_ms);
}

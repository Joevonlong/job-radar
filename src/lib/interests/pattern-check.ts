/**
 * The save check of the vocabulary's patterns that the schema cannot make: a pattern that compiles but is too slow on the
 * probe's long test texts (`signalPatternIsFast`, limits of pipeline.yaml `filter.deal_breakers`). The rules would leave it
 * out of every scan, so saving refuses it and the preview reports it. Server code only (the probe runs in node:vm).
 */
import { slowInterestPatterns, type InterestsConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import { signalPatternIsFast, signalProbeLimits } from "@/lib/signals/pattern-guard";

import type { DraftCandidate, VocabularyFieldError } from "./vocabulary-draft";

/** The slow patterns of `config` as field errors in draft space; none when pipeline.yaml cannot be read (its own page reports that). */
export function slowPatternErrors(config: Pick<InterestsConfig, "signals">, draftPath: DraftCandidate["draftPath"]): VocabularyFieldError[] {
  let isFast: (pattern: string) => boolean;
  try {
    isFast = signalPatternIsFast(signalProbeLimits(loadPipeline()));
  } catch {
    return [];
  }
  return slowInterestPatterns(config, isFast).map((slow): VocabularyFieldError => ({ path: draftPath(slow.path), key: "slowPattern" }));
}

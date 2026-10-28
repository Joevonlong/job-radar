/**
 * The save check of the vocabulary's patterns that the schema cannot make: a pattern that compiles but is too slow on the
 * probe's long test texts (`signalPatternIsFast`, limits of interests.yaml `limits`). The rules would leave it out of every
 * scan, so saving refuses it and the preview reports it. Server code only (the probe runs in node:vm).
 */
import { slowInterestPatterns, type InterestsConfig } from "@/lib/config";
import { signalPatternIsFast } from "@/lib/signals/pattern-guard";

import type { DraftCandidate, VocabularyFieldError } from "./vocabulary-draft";

/** The slow patterns of `config` (probed with its own limits) as field errors in draft space. */
export function slowPatternErrors(config: Pick<InterestsConfig, "signals" | "limits">, draftPath: DraftCandidate["draftPath"]): VocabularyFieldError[] {
  return slowInterestPatterns(config, signalPatternIsFast(config.limits)).map((slow): VocabularyFieldError => ({ path: draftPath(slow.path), key: "slowPattern" }));
}

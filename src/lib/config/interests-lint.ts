/**
 * Checks of interests.yaml that the schema cannot make errors of: a valid file that cannot do what its author
 * wants. They are warnings: `pnpm config:check` prints them and the file editor shows them, a save still goes through.
 */
import type { InterestsConfig } from "./schemas/interests";

export interface InterestsWarning {
  code: "interests.semantic_only_unreachable";
  path: Array<string | number>;
  message: string;
}

/**
 * A keyword category without words or patterns has no rule hits, so only the AI review finds it; with
 * `limits.ai_review_without_candidates: false` the AI reads only jobs with rule hits, and the category never matches.
 */
export function interestsWarnings(config: Pick<InterestsConfig, "signals" | "limits">): InterestsWarning[] {
  if (config.limits.ai_review_without_candidates) return [];
  const warnings: InterestsWarning[] = [];
  config.signals.categories.forEach((category, index) => {
    if (category.kind !== "keyword" || category.keywords.length > 0 || category.patterns.length > 0) return;
    warnings.push({
      code: "interests.semantic_only_unreachable",
      path: ["signals", "categories", index],
      message: `category "${category.id}" has no keywords or patterns and limits.ai_review_without_candidates is false: it can never match (add words or patterns, or turn that limit on)`,
    });
  });
  return warnings;
}

/** The message of an interests.yaml pattern that is too slow on the probe's test texts (the file editor shows its own text for it). */
export const SLOW_PATTERN_MESSAGE = "too slow on a long test text (interests.yaml limits.pattern_probe_ms / limits.pattern_probe_retry_ms): give each + and * an upper limit";

/** A pattern of an active category that fails the probe; `path` is inside interests.yaml (a `tag_patterns` entry: its `pattern`). */
export interface SlowInterestPattern {
  categoryId: string;
  path: Array<string | number>;
}

/**
 * The user patterns (`patterns`, `exclude`, `tag_patterns`) of the active categories that `isFast` refuses. `isFast` is the
 * server's probe (`signalPatternIsFast`, which runs each pattern on long test texts in a time box); saving refuses these.
 */
export function slowInterestPatterns(config: Pick<InterestsConfig, "signals">, isFast: (pattern: string) => boolean): SlowInterestPattern[] {
  const slow: SlowInterestPattern[] = [];
  config.signals.categories.forEach((category, index) => {
    const at = ["signals", "categories", index];
    const check = (field: "patterns" | "exclude", sources: readonly string[]): void => {
      sources.forEach((source, position) => {
        if (!isFast(source)) slow.push({ categoryId: category.id, path: [...at, field, position] });
      });
    };
    if (category.kind === "tag") {
      category.tag_patterns.forEach((entry, position) => {
        if (!isFast(entry.pattern)) slow.push({ categoryId: category.id, path: [...at, "tag_patterns", position, "pattern"] });
      });
      return;
    }
    check("patterns", category.patterns);
    check("exclude", category.exclude);
  });
  return slow;
}

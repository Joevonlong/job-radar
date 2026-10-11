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

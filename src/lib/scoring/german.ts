import type { AiConfig, MeConfig, PipelineConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import { explicitRequiredGermanLevels } from "@/lib/pipeline/language";
import { GERMAN_LEVELS, isGermanRequirement, type GermanLevel } from "@/lib/domain/types";

/** CEFR levels in ascending order; the position is the rank used to compare levels. */
const CEFR = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
type CefrLevel = (typeof CEFR)[number];

const isCefr = (level: string): level is CefrLevel => (CEFR as readonly string[]).includes(level);

/**
 * The "German level" columns and functions mean the market's LOCAL language (`market.home_language`). `language`
 * is that language's code; null = the language step is off (nothing is read, nothing costs points).
 */

/** The user's own level of the local language, as a rank: -1 = none at all, 0..5 = A1..C2, 6 = native. */
export function userLanguageRank(me: Pick<MeConfig, "languages">, language: string): number {
  for (const entry of me.languages) {
    const level = entry[language];
    if (level === undefined) continue;
    if (level === "native") return CEFR.length;
    return CEFR.indexOf(level);
  }
  return -1;
}

export function userLanguageLabel(me: Pick<MeConfig, "languages">, language: string): string {
  const rank = userLanguageRank(me, language);
  return rank < 0 ? "none" : rank >= CEFR.length ? "native" : (CEFR[rank] ?? "none");
}

/**
 * Points to take off the match score because the posting requires more of the local language than the user has.
 * `none` / `unknown` and levels at or below the user's own cost nothing; the amounts come from
 * ai.yaml `scoring.language_penalty` (levels without an entry cost nothing). The step off (`language` null): 0.
 */
export function languagePenalty(required: GermanLevel, me: Pick<MeConfig, "languages">, table: AiConfig["scoring"]["language_penalty"], language: string | null): number {
  if (language === null || !isCefr(required)) return 0;
  if (CEFR.indexOf(required) <= userLanguageRank(me, language)) return 0;
  return table[required] ?? 0;
}

/**
 * CEFR levels the JD names as a requirement in a clause that talks about German ("German C1",
 * "Deutsch (B2)"). Only an explicit level counts, and only where it is asked for: a level next to
 * "a plus" or under "Preferred qualifications" is not. This is what makes one reading of the JD
 * "more explicit" than another. The rules are the pipeline's (pipeline.yaml `language`).
 */
export function explicitGermanLevels(text: string, config: PipelineConfig = loadPipeline()): Set<GermanLevel> {
  return explicitRequiredGermanLevels(text, config);
}

export type GermanSource =
  /** The rule value (pipeline) and the AI agree. */
  | "agree"
  /** Only the rule value says something; the AI said `unknown`. */
  | "rule"
  /** Only the AI says something; the rule value is `unknown`. */
  | "ai"
  /** They differ; the JD names the rule's level explicitly and not the AI's. */
  | "rule_explicit"
  /** They differ; the JD names the AI's level explicitly and not the rule's. */
  | "ai_explicit"
  /** They differ, neither is explicit in the JD (or the rule read an explicit "not needed" / "preferred"): the rule value stands. */
  | "rule_preferred";

export interface ResolvedGerman {
  level: GermanLevel;
  source: GermanSource;
}

export const GERMAN_SOURCES: readonly GermanSource[] = ["agree", "rule", "ai", "rule_explicit", "ai_explicit", "rule_preferred"];

/**
 * Reconcile the rule-based German level of the pipeline (`jobs.german_level_required`) with the AI's
 * reading. Where they disagree the one the JD states more explicitly (a CEFR level next to the word
 * German/Deutsch) wins; if neither is explicit the rule value stands, because it comes from the
 * posting's wording (e.g. "German is a plus" => preferred, never a requirement) and is reproducible. The outcome and its source
 * are stored so a disagreement can be looked at (`scores.german_level_source`).
 */
export function resolveGermanLevel(input: { rule: GermanLevel; ai: GermanLevel; jdText: string; pipeline?: PipelineConfig }): ResolvedGerman {
  const { rule, ai } = input;
  if (!GERMAN_LEVELS.includes(rule) || !GERMAN_LEVELS.includes(ai)) throw new Error("unknown German level");
  if (rule === ai) return { level: rule, source: "agree" };
  if (rule === "unknown") return { level: ai, source: "ai" };
  if (ai === "unknown") return { level: rule, source: "rule" };
  // the rule read an explicit "not required" or "preferred / a plus": that wording beats an AI guess of a level
  if (!isGermanRequirement(rule)) return { level: rule, source: "rule_preferred" };
  const explicit = explicitGermanLevels(input.jdText, input.pipeline);
  const ruleExplicit = explicit.has(rule);
  const aiExplicit = explicit.has(ai);
  if (aiExplicit && !ruleExplicit) return { level: ai, source: "ai_explicit" };
  if (ruleExplicit && !aiExplicit) return { level: rule, source: "rule_explicit" };
  return { level: rule, source: "rule_preferred" };
}

/**
 * The German levels that cost points for this user: the ones above the user's own level that have a
 * deduction in the table. This is what the "hide German-required" quick filter hides.
 */
export function penalizedLanguageLevels(me: Pick<MeConfig, "languages"> | null, table: AiConfig["scoring"]["language_penalty"], language: string | null): GermanLevel[] {
  if (language === null) return [];
  const userRank = me === null ? -1 : userLanguageRank(me, language);
  return CEFR.filter((level) => CEFR.indexOf(level) > userRank && (table[level] ?? 0) > 0);
}

import type { PipelineConfig } from "@/lib/config";
import type { LanguageRequirement } from "@/lib/market/schema";

/**
 * pipeline.yaml compiled once per loaded config object (a hot reload yields a new object, so the
 * cache never goes stale). The config schema has already checked that every pattern compiles.
 */

export interface CompiledRules {
  agencyCompanyName: RegExp[];
  agencyText: RegExp[];
  agencyExclude: RegExp[];
  contract: Record<keyof PipelineConfig["contract"], RegExp[]>;
  /** The local-language requirement rules (from the market pack); null = the step is off. */
  language: CompiledLanguageRules | null;
  workplaceHead: Record<"remote" | "hybrid" | "onsite", RegExp[]>;
  workplaceText: Record<"remote" | "hybrid" | "onsite", RegExp[]>;
  workplaceNegation: RegExp[];
  trailingUi: RegExp[];
  salaryContext: RegExp[];
  salaryNegative: RegExp[];
  salaryOtherRegion: RegExp[];
  salaryVariable: RegExp[];
  skills: Array<{ name: string; pattern: RegExp }>;
}

export interface CompiledLanguageRules {
  requirement: LanguageRequirement;
  /** A mention of the language (global). */
  word: RegExp;
  /** "German C1", "Deutschkenntnisse auf B2-Niveau": the level after the name (group 1). */
  cefrAfter: RegExp;
  /** "C1 German", "B2-level German": the level before the name (group 1). */
  cefrBefore: RegExp;
  levelRules: Array<{ pattern: RegExp; level: LanguageRequirement["level_rules"][number]["level"] }>;
  optional: RegExp[];
  ignore: RegExp[];
  preferredSection: RegExp[];
  requiredSection: RegExp[];
  requiredCue: RegExp[];
  notRequired: RegExp[];
  sufficient: RegExp[];
}

const compile = (patterns: readonly string[]): RegExp[] => patterns.map((p) => new RegExp(p, "iu"));

const languageCache = new WeakMap<LanguageRequirement, CompiledLanguageRules>();

/** The requirement rules of a pack compiled; the CEFR expressions are built from the pack's name and connector words. */
export function compileLanguageRules(requirement: LanguageRequirement): CompiledLanguageRules {
  const hit = languageCache.get(requirement);
  if (hit) return hit;
  const name = requirement.cefr_name_pattern;
  const levelWords = requirement.cefr_level_words.length > 0 ? `(?:[\\s-]*(?:${requirement.cefr_level_words.join("|")}))?` : "";
  const prepositions = requirement.cefr_prepositions.length > 0 ? `(?:${requirement.cefr_prepositions.map((p) => `${p}\\s+`).join("|")})?` : "";
  const rules: CompiledLanguageRules = {
    requirement,
    word: new RegExp(requirement.word_pattern, "giu"),
    cefrAfter: new RegExp(
      `(?:${name})(?:[\\s(:\\-\u2013]|(?<![\\p{L}])(?:${requirement.cefr_connectors.join("|")})(?![\\p{L}])){0,8}?(?<![\\p{L}\\p{N}])([ABC][12])(?![\\p{L}\\p{N}])`,
      "iu",
    ),
    cefrBefore: new RegExp(`(?<![\\p{L}\\p{N}])([ABC][12])(?![\\p{L}\\p{N}])${levelWords}\\s+${prepositions}(?:${name})`, "iu"),
    levelRules: requirement.level_rules.map((r) => ({ pattern: new RegExp(r.pattern, "iu"), level: r.level })),
    optional: compile(requirement.optional_patterns),
    ignore: compile(requirement.ignore_patterns),
    preferredSection: compile(requirement.preferred_section_patterns),
    requiredSection: compile(requirement.required_section_patterns),
    requiredCue: compile(requirement.required_patterns),
    notRequired: compile(requirement.not_required_patterns),
    sufficient: compile(requirement.sufficient_patterns),
  };
  languageCache.set(requirement, rules);
  return rules;
}

const cache = new WeakMap<PipelineConfig, CompiledRules>();

export function compileRules(config: PipelineConfig): CompiledRules {
  const hit = cache.get(config);
  if (hit) return hit;
  const rules: CompiledRules = {
    agencyCompanyName: compile(config.agency.company_name_patterns),
    agencyText: compile(config.agency.text_patterns),
    agencyExclude: compile(config.agency.exclude_context_patterns),
    contract: {
      student: compile(config.contract.student),
      temp_agency: compile(config.contract.temp_agency),
      direct_hire: compile(config.contract.direct_hire),
      freelance: compile(config.contract.freelance),
      fixed_term: compile(config.contract.fixed_term),
      permanent: compile(config.contract.permanent),
    },
    language: config.language.requirement === null ? null : compileLanguageRules(config.language.requirement),
    workplaceHead: {
      remote: compile(config.workplace.head.remote),
      hybrid: compile(config.workplace.head.hybrid),
      onsite: compile(config.workplace.head.onsite),
    },
    workplaceText: {
      remote: compile(config.workplace.text.remote),
      hybrid: compile(config.workplace.text.hybrid),
      onsite: compile(config.workplace.text.onsite),
    },
    workplaceNegation: compile(config.workplace.negation_patterns),
    trailingUi: compile(config.description.trailing_ui_patterns),
    salaryContext: compile(config.salary.description_context_patterns),
    salaryNegative: compile(config.salary.negative_context_patterns),
    salaryOtherRegion: compile(config.salary.other_region_patterns),
    salaryVariable: compile(config.salary.variable_patterns),
    skills: config.skills.map((s) => ({ name: s.name, pattern: new RegExp(s.pattern, "iu") })),
  };
  cache.set(config, rules);
  return rules;
}

export function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

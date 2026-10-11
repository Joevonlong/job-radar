/**
 * The ghost job patterns of the market packs and the limits of pipeline.yaml `job_checks.ghost`, compiled once per configuration
 * (C8: every word is in the packs, every number in pipeline.yaml).
 */
import type { GhostCheckConfig, PipelineConfig } from "@/lib/config/schemas/pipeline";
import type { GhostLeadInQuestion, GhostNegationAfter, GhostPack } from "@/lib/market/schema";

export interface CompiledGhostPattern {
  id: string;
  /** Flags `giu`: used with `matchAll` / `search` only (both ignore and keep `lastIndex`). */
  re: RegExp;
  /** false: a phrase that is a negation itself; a negation cue around it does not cancel it. */
  checkNegation: boolean;
  /** How far after the phrase a negation cue is searched: `negation_words_after` words, or to the end of the clause. */
  negationAfter: GhostNegationAfter;
}

export interface CompiledGhostRules {
  settings: GhostCheckConfig;
  repostLabels: CompiledGhostPattern[];
  evergreen: CompiledGhostPattern[];
  /** Tested against one heading's text (flags `iu`). */
  responsibilities: Array<{ id: string; re: RegExp }>;
  /** Anchored (`^(?:cue)$`): tested against one word. */
  negationCues: RegExp[];
  clauseBreaks: RegExp[];
  excludeContext: RegExp[];
  /** Which question before a sentence is read with it (the packs' `lead_in_question`; no `ends` = none). */
  leadInQuestion: GhostLeadInQuestion;
  abbreviations: string[];
  /** The packs' `prefilter` as one expression (flags `iu`); null = none, every sentence is read. */
  prefilter: RegExp | null;
  /** `evergreen_patterns` whose own source has no prefilter match (`ghost.evergreen_patterns[2]`), for `pnpm config:check`. */
  prefilterViolations: string[];
}

/** What `compileGhostRules` reads of the effective pipeline config. */
export type GhostRulesInput = Pick<PipelineConfig, "ghost"> & { job_checks: Pick<PipelineConfig["job_checks"], "ghost"> };

function compile(source: string, path: string, flags = "giu"): RegExp {
  try {
    return new RegExp(source, flags);
  } catch (error) {
    throw new Error(`ghost pattern ${path} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const compileList = (sources: readonly string[], path: string): RegExp[] => sources.map((source, index) => compile(source, `${path}[${index}]`));

function compilePrefilter(sources: readonly string[]): RegExp | null {
  if (sources.length === 0) return null;
  sources.forEach((source, index) => compile(source, `ghost.prefilter[${index}]`));
  return new RegExp(sources.map((source) => `(?:${source})`).join("|"), "iu");
}

export function compileGhostRules(config: GhostRulesInput): CompiledGhostRules {
  const pack: GhostPack = config.ghost;
  const prefilter = compilePrefilter(pack.prefilter);
  const prefilterViolations: string[] = [];
  if (prefilter !== null) {
    pack.evergreen_patterns.forEach((entry, index) => {
      if (!prefilter.test(entry.pattern)) prefilterViolations.push(`ghost.evergreen_patterns[${index}]`);
    });
  }
  return {
    settings: config.job_checks.ghost,
    repostLabels: pack.repost_label_patterns.map((entry, index) => ({ id: entry.id, re: compile(entry.pattern, `ghost.repost_label_patterns[${index}]`), checkNegation: false, negationAfter: "words" })),
    evergreen: pack.evergreen_patterns.map((entry, index) => ({
      id: entry.id,
      re: compile(entry.pattern, `ghost.evergreen_patterns[${index}]`),
      checkNegation: entry.check_negation,
      negationAfter: entry.negation_after ?? pack.negation_after,
    })),
    responsibilities: pack.responsibility_patterns.map((entry, index) => ({ id: entry.id, re: compile(entry.pattern, `ghost.responsibility_patterns[${index}]`, "iu") })),
    negationCues: pack.negation_cues.map((cue, index) => {
      compile(cue, `ghost.negation_cues[${index}]`);
      return new RegExp(`^(?:${cue})$`, "iu");
    }),
    clauseBreaks: compileList(pack.clause_breaks, "ghost.clause_breaks"),
    excludeContext: compileList(pack.exclude_context, "ghost.exclude_context"),
    leadInQuestion: { ends: [...pack.lead_in_question.ends], starts: [...pack.lead_in_question.starts], line_above: pack.lead_in_question.line_above },
    abbreviations: [...pack.abbreviations],
    prefilter,
    prefilterViolations,
  };
}

const cache = new WeakMap<object, CompiledGhostRules>();

/** `compileGhostRules`, cached per config object (the effective pipeline config is frozen and reused until it changes). */
export function ghostRulesFor(config: GhostRulesInput): CompiledGhostRules {
  const cached = cache.get(config);
  if (cached) return cached;
  const rules = compileGhostRules(config);
  cache.set(config, rules);
  return rules;
}

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
  /** A hit counts only when its piece also matches one of these (flags `iu`); empty = always. */
  requiresContext: RegExp[];
  /** A hit counts only above the JD's first duties heading (a title line, not the footer of a real posting). */
  onlyBeforeDuties: boolean;
}

/** The packs' `question_tag`, compiled: a statement with a short invitation tagged on is not a question. */
export interface CompiledQuestionTag {
  /** Flags `giu`: where the tag starts (after the last match). */
  breaks: RegExp[];
  /** Anchored (`^(?:invitation)$`, flags `iu`): tested against the whole tag, without its question mark. */
  invitations: RegExp[];
  /** Anchored at the start and at a word end (`^(?:opener)(?![\p{L}\p{N}])`, flags `iu`): tested against a clause's text from a word on. */
  openers: RegExp[];
  /** As `openers`: the words or phrases skipped before the opener test ("so", "and", "wie immer"). */
  markers: RegExp[];
}

export interface CompiledGhostRules {
  settings: GhostCheckConfig;
  repostLabels: CompiledGhostPattern[];
  evergreen: CompiledGhostPattern[];
  /** Tested against one heading's text (flags `iu`). */
  responsibilities: Array<{ id: string; re: RegExp }>;
  /** Anchored (`^(?:cue)$`): tested against one word. */
  negationCues: RegExp[];
  /** Anchored (`^(?:word)$`): tested against the first word of a heading that ends in "?". */
  questionWords: RegExp[];
  clauseBreaks: RegExp[];
  excludeContext: RegExp[];
  /** Flags `giu`: a match takes out the hits from its start to the end of its clause. */
  excludeClause: RegExp[];
  /** Flags `giu`: where an `excludeClause` range also ends, besides `clauseBreaks`. */
  excludeClauseEnds: RegExp[];
  questionTag: CompiledQuestionTag;
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

/** Word lists (`negation_cues`, `question_words`): each entry must match one whole word. */
const anchoredWords = (sources: readonly string[], path: string): RegExp[] =>
  sources.map((source, index) => {
    compile(source, `${path}[${index}]`);
    return new RegExp(`^(?:${source})$`, "iu");
  });

/** `question_tag.openers` / `.markers`: each entry is matched at the start of a text and must end at a word end. */
const leadingPhrases = (sources: readonly string[], path: string): RegExp[] =>
  sources.map((source, index) => {
    compile(source, `${path}[${index}]`);
    return new RegExp(`^(?:${source})(?![\\p{L}\\p{N}])`, "iu");
  });

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
    repostLabels: pack.repost_label_patterns.map((entry, index) => ({ id: entry.id, re: compile(entry.pattern, `ghost.repost_label_patterns[${index}]`), checkNegation: false, negationAfter: "words", requiresContext: [], onlyBeforeDuties: false })),
    evergreen: pack.evergreen_patterns.map((entry, index) => ({
      id: entry.id,
      re: compile(entry.pattern, `ghost.evergreen_patterns[${index}]`),
      checkNegation: entry.check_negation,
      negationAfter: entry.negation_after ?? pack.negation_after,
      requiresContext: (entry.requires_context ?? []).map((source, at) => compile(source, `ghost.evergreen_patterns[${index}].requires_context[${at}]`, "iu")),
      onlyBeforeDuties: entry.only_before_duties === true,
    })),
    responsibilities: pack.responsibility_patterns.map((entry, index) => ({ id: entry.id, re: compile(entry.pattern, `ghost.responsibility_patterns[${index}]`, "iu") })),
    negationCues: anchoredWords(pack.negation_cues, "ghost.negation_cues"),
    questionWords: anchoredWords(pack.question_words, "ghost.question_words"),
    clauseBreaks: compileList(pack.clause_breaks, "ghost.clause_breaks"),
    excludeContext: compileList(pack.exclude_context, "ghost.exclude_context"),
    excludeClause: compileList(pack.exclude_clause, "ghost.exclude_clause"),
    excludeClauseEnds: compileList(pack.exclude_clause_ends, "ghost.exclude_clause_ends"),
    questionTag: {
      breaks: compileList(pack.question_tag.breaks, "ghost.question_tag.breaks"),
      invitations: pack.question_tag.invitations.map((source, index) => {
        compile(source, `ghost.question_tag.invitations[${index}]`);
        return new RegExp(`^(?:${source})$`, "iu");
      }),
      openers: leadingPhrases(pack.question_tag.openers, "ghost.question_tag.openers"),
      markers: leadingPhrases(pack.question_tag.markers, "ghost.question_tag.markers"),
    },
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

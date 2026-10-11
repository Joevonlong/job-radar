/**
 * The visa patterns of the market packs, compiled once per configuration (C8: every word is in the packs, every limit in
 * pipeline.yaml). Pure (no node modules): the deal-breaker filter, which the job pages' client code reaches, uses it too.
 */
import type { PipelineConfig } from "@/lib/config/schemas/pipeline";
import type { VisaPatternEntry } from "@/lib/market/schema";

export interface CompiledVisaPattern {
  /** Flags `giu`: used with `matchAll` / `search` only (both ignore and keep `lastIndex`). */
  re: RegExp;
  /** Never matches the bare word "visa": the only kind that counts on postings of a company named like it. */
  combo: boolean;
  /** Counts only in a segment of a list item ("- Visa sponsorship"). */
  listItem: boolean;
}

export interface CompiledVisaRules {
  offered: CompiledVisaPattern[];
  noSponsorship: CompiledVisaPattern[];
  permitRequired: CompiledVisaPattern[];
  permitAlternatives: RegExp[];
  mentionTerms: CompiledVisaPattern[];
  mentionContext: RegExp[];
  /** Anchored (`^(?:cue)$`): tested against one word. */
  negationCues: RegExp[];
  /** Where the clause after an offered phrase ends for the negation search (flags `giu`, used with `search`). */
  clauseBreaks: RegExp[];
  negationWordsBefore: number;
  negationWordsAfter: number;
  headingMaxChars: number;
  excludeContext: RegExp[];
  excludeCompanies: RegExp[];
  abbreviations: string[];
  /** The packs' `prefilter` as one expression (flags `iu`, no state); null = none, every sentence is read. */
  prefilter: RegExp | null;
  /**
   * Phrase patterns (`offered`, `not_offered.*`, `mention_terms`) whose own source has no prefilter match, as `visa.offered[2]`
   * paths. A heuristic for the packs' promise that every phrase contains a prefilter word (a pattern breaking it is silently skipped
   * on texts without one); `pnpm config:check` lists them as warnings.
   */
  prefilterViolations: string[];
  maxQuotes: number;
  quoteMaxChars: number;
}

/** What `compileVisaRules` reads of the effective pipeline config. */
export type VisaRulesInput = Pick<PipelineConfig, "visa"> & { job_checks: Pick<PipelineConfig["job_checks"], "visa"> };

function compile(source: string, path: string): RegExp {
  try {
    return new RegExp(source, "giu");
  } catch (error) {
    throw new Error(`visa pattern ${path} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function compileEntries(entries: readonly VisaPatternEntry[], path: string): CompiledVisaPattern[] {
  return entries.map((entry, index) =>
    typeof entry === "string"
      ? { re: compile(entry, `${path}[${index}]`), combo: false, listItem: false }
      : { re: compile(entry.pattern, `${path}[${index}]`), combo: entry.combo, listItem: entry.list_item },
  );
}

const compileList = (sources: readonly string[], path: string): RegExp[] => sources.map((source, index) => compile(source, `${path}[${index}]`));

function compilePrefilter(sources: readonly string[]): RegExp | null {
  if (sources.length === 0) return null;
  sources.forEach((source, index) => compile(source, `visa.prefilter[${index}]`));
  return new RegExp(sources.map((source) => `(?:${source})`).join("|"), "iu");
}

function prefilterViolations(pack: VisaRulesInput["visa"], prefilter: RegExp | null): string[] {
  if (prefilter === null) return [];
  const lists: Array<[string, readonly VisaPatternEntry[]]> = [
    ["visa.offered", pack.offered],
    ["visa.not_offered.no_sponsorship", pack.not_offered.no_sponsorship],
    ["visa.not_offered.permit_required", pack.not_offered.permit_required],
    ["visa.mention_terms", pack.mention_terms],
  ];
  const out: string[] = [];
  for (const [path, entries] of lists) {
    entries.forEach((entry, index) => {
      if (!prefilter.test(typeof entry === "string" ? entry : entry.pattern)) out.push(`${path}[${index}]`);
    });
  }
  return out;
}

export function compileVisaRules(config: VisaRulesInput): CompiledVisaRules {
  const pack = config.visa;
  const limits = config.job_checks.visa;
  const prefilter = compilePrefilter(pack.prefilter);
  return {
    offered: compileEntries(pack.offered, "visa.offered"),
    noSponsorship: compileEntries(pack.not_offered.no_sponsorship, "visa.not_offered.no_sponsorship"),
    permitRequired: compileEntries(pack.not_offered.permit_required, "visa.not_offered.permit_required"),
    permitAlternatives: compileList(pack.permit_alternatives, "visa.permit_alternatives"),
    mentionTerms: compileEntries(pack.mention_terms, "visa.mention_terms"),
    mentionContext: compileList(pack.mention_context, "visa.mention_context"),
    negationCues: pack.negation_cues.map((cue, index) => {
      compile(cue, `visa.negation_cues[${index}]`);
      return new RegExp(`^(?:${cue})$`, "iu");
    }),
    clauseBreaks: compileList(pack.clause_breaks, "visa.clause_breaks"),
    negationWordsBefore: limits.negation_words_before,
    negationWordsAfter: limits.negation_words_after,
    headingMaxChars: limits.heading_max_chars,
    excludeContext: compileList(pack.exclude_context, "visa.exclude_context"),
    excludeCompanies: compileList(pack.exclude_companies, "visa.exclude_companies"),
    abbreviations: [...pack.abbreviations],
    prefilter,
    prefilterViolations: prefilterViolations(pack, prefilter),
    maxQuotes: limits.max_quotes,
    quoteMaxChars: limits.quote_max_chars,
  };
}

const cache = new WeakMap<object, CompiledVisaRules>();

/** `compileVisaRules`, cached per config object (the effective pipeline config is frozen and reused until it changes). */
export function visaRulesFor(config: VisaRulesInput): CompiledVisaRules {
  const cached = cache.get(config);
  if (cached) return cached;
  const rules = compileVisaRules(config);
  cache.set(config, rules);
  return rules;
}

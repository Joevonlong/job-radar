/**
 * Deal-breakers: the user's own veto rules (preferences.yaml `deal_breakers`), judged in the hard filter before any AI
 * call. Pure: no database, no file reads; the caller passes the market's local language and the user's level of it.
 * A vetoed job is kept (C1) with the reason `deal_breaker:<id>`; what a posting does not say never vetoes (C3).
 */
import type { MeConfig, PipelineConfig } from "@/lib/config";
import type { DealBreaker } from "@/lib/config/schemas/preferences";
import { isGermanRequirement, type GermanLevel } from "@/lib/domain/types";
import { requiredLevelSpan } from "@/lib/pipeline/language";
import { sentenceAround } from "@/lib/signals/quote";

import { wholeWordSource } from "./rules";

/** CEFR levels in ascending order: the index is the rank (-1 = none, 6 = native). */
const CEFR: readonly string[] = ["A1", "A2", "B1", "B2", "C1", "C2"];
const NATIVE_RANK = CEFR.length;

/** What the rules need besides the job: the limits and the language the gate compares. */
export interface DealBreakerContext {
  /** The market's local language (`market.language.code`); null = the language step is off, a language gate does nothing. */
  language: string | null;
  /** me.yaml, or null when it cannot be read (a gate without `at_least` then does nothing). */
  me: Pick<MeConfig, "languages"> | null;
  limits: PipelineConfig["filter"]["deal_breakers"];
}

/** The fields of a job the rules read. */
export interface DealBreakerJob {
  title: string;
  description: string | null;
  /** `jobs.german_level_required`: the pipeline's rule reading of the local language (never the AI's). */
  germanLevel: GermanLevel;
}

export type DealBreakerWarningCode = "no_language_step" | "me_unreadable" | "too_many_rules" | "pattern_too_long";

export interface DealBreakerWarning {
  id: string;
  code: DealBreakerWarningCode;
}

interface CompiledGate {
  rule: Extract<DealBreaker, { type: "language_gate" }>;
  /** The lowest rank that vetoes. */
  threshold: number;
}

interface CompiledPhrase {
  rule: Extract<DealBreaker, { type: "phrase" }>;
  /** Terms and patterns, global (scanned with `exec`). */
  matchers: RegExp[];
  unless: RegExp[];
}

export type CompiledDealBreaker = CompiledGate | CompiledPhrase;

export interface CompiledDealBreakers {
  rules: readonly CompiledDealBreaker[];
  /** Rules that are written but do nothing (see `DealBreakerWarningCode`). */
  warnings: readonly DealBreakerWarning[];
  matchTextMaxChars: number;
}

const isGate = (rule: CompiledDealBreaker): rule is CompiledGate => rule.rule.type === "language_gate";

/**
 * The user's rank of the local language (-1 = none listed, 0..5 = A1..C2, 6 = native): the same reading as
 * `userLanguageRank` of scoring, kept here because that module loads config files, and the job pages' client code reaches
 * this one through the filter's text helpers (a test holds the two equal).
 */
export function userLocalRank(me: Pick<MeConfig, "languages">, language: string): number {
  for (const entry of me.languages) {
    const level = entry[language];
    if (level === undefined) continue;
    return level === "native" ? NATIVE_RANK : CEFR.indexOf(level);
  }
  return -1;
}

/** Rank -> "B1", "native", "none". */
export function rankLabel(rank: number): string {
  return rank < 0 ? "none" : rank >= NATIVE_RANK ? "native" : (CEFR[rank] ?? "none");
}

/**
 * A user pattern as a RegExp. V8 runs `\b` very slowly when the `i` and `u` flags are both set (no position can be skipped:
 * about 15 times slower over a description), and `\bno travel\b` is the usual way to write a pattern. A pattern that uses
 * nothing of the `u` flag (no `\p{…}`, no `\u{…}`) matches the same in job text without it, so a pattern with a word
 * boundary is compiled without `u` (the schema has already checked it with `u`, which is the stricter syntax).
 */
function userRegExp(source: string, flags: "giu" | "iu"): RegExp {
  if (/\\[bB]/u.test(source) && !/\\(?:[pP]|u\{)/u.test(source)) {
    try {
      return new RegExp(source, flags.replace("u", ""));
    } catch {
      // not valid without u: keep it
    }
  }
  return new RegExp(source, flags);
}

/** Compile the enabled rules once for many jobs. Rules over the pipeline.yaml limits and gates that cannot work are left out, with a warning. */
export function compileDealBreakers(rules: readonly DealBreaker[], context: DealBreakerContext): CompiledDealBreakers {
  const compiled: CompiledDealBreaker[] = [];
  const warnings: DealBreakerWarning[] = [];
  const { limits } = context;
  rules.forEach((rule, index) => {
    if (index >= limits.max_rules) {
      warnings.push({ id: rule.id, code: "too_many_rules" });
      return;
    }
    if (!rule.enabled) return;
    if (rule.type === "language_gate") {
      if (context.language === null) {
        warnings.push({ id: rule.id, code: "no_language_step" });
        return;
      }
      if (rule.at_least !== undefined) {
        compiled.push({ rule, threshold: CEFR.indexOf(rule.at_least) });
        return;
      }
      if (context.me === null) {
        warnings.push({ id: rule.id, code: "me_unreadable" });
        return;
      }
      compiled.push({ rule, threshold: userLocalRank(context.me, context.language) + 1 });
      return;
    }
    if ([...rule.terms, ...rule.patterns, ...rule.unless].some((text) => text.length > limits.max_pattern_chars)) {
      warnings.push({ id: rule.id, code: "pattern_too_long" });
      return;
    }
    const matchers: RegExp[] = [];
    if (rule.terms.length > 0) matchers.push(new RegExp(wholeWordSource(rule.terms, true), "giu"));
    for (const pattern of rule.patterns) matchers.push(userRegExp(pattern, "giu"));
    compiled.push({ rule, matchers, unless: rule.unless.map((pattern) => userRegExp(pattern, "iu")) });
  });
  return { rules: compiled, warnings, matchTextMaxChars: limits.match_text_max_chars };
}

interface Hit {
  field: "title" | "description";
  start: number;
  end: number;
}

const endsSentence = (char: string): boolean => char === "." || char === "!" || char === "?";
const isSpace = (char: string): boolean => /\s/u.test(char);

/**
 * The sentence around a hit, the way the quotes cut it (`sentenceAround`): within its line, from after the last ".", "!" or "?"
 * that is followed by whitespace, to the next one. Found by scanning from the hit (a description is often one long line).
 */
function sentenceOf(text: string, start: number, end: number): string {
  let from = start;
  while (from > 0) {
    const before = text.charAt(from - 1);
    if (before === "\n" || (isSpace(before) && from >= 2 && endsSentence(text.charAt(from - 2)))) break;
    from -= 1;
  }
  let to = Math.max(end, start + 1);
  while (to < text.length) {
    const char = text.charAt(to);
    if (char === "\n") break;
    if (endsSentence(char) && (to + 1 === text.length || isSpace(text.charAt(to + 1)))) {
      to += 1;
      break;
    }
    to += 1;
  }
  return text.slice(from, to);
}

/** A sentence holding the hit matches one of `unless` ("no travel required"): the hit does not count. */
function excused(text: string, start: number, end: number, unless: readonly RegExp[]): boolean {
  if (unless.length === 0) return false;
  const sentence = sentenceOf(text, start, end);
  return unless.some((pattern) => pattern.test(sentence));
}

function firstHit(text: string, rule: CompiledPhrase): { start: number; end: number } | null {
  for (const matcher of rule.matchers) {
    matcher.lastIndex = 0;
    for (let m = matcher.exec(text); m !== null; m = matcher.exec(text)) {
      if (m[0].length === 0) {
        matcher.lastIndex += 1;
        continue;
      }
      if (!excused(text, m.index, m.index + m[0].length, rule.unless)) return { start: m.index, end: m.index + m[0].length };
    }
  }
  return null;
}

function phraseHit(job: DealBreakerJob, rule: CompiledPhrase, maxChars: number): Hit | null {
  const scope = rule.rule.scope;
  if (scope !== "description") {
    const hit = firstHit(job.title, rule);
    if (hit) return { field: "title", ...hit };
  }
  if (scope !== "title" && job.description) {
    const hit = firstHit(job.description.length > maxChars ? job.description.slice(0, maxChars) : job.description, rule);
    if (hit) return { field: "description", ...hit };
  }
  return null;
}

function gateHits(job: DealBreakerJob, rule: CompiledGate): boolean {
  return isGermanRequirement(job.germanLevel) && CEFR.indexOf(job.germanLevel) >= rule.threshold;
}

/** Whether one compiled rule vetoes the job. */
export function dealBreakerHits(job: DealBreakerJob, rule: CompiledDealBreaker, maxChars: number): boolean {
  return isGate(rule) ? gateHits(job, rule) : phraseHit(job, rule, maxChars) !== null;
}

/** The ids of the rules that veto the job, in the order of the file. */
export function checkDealBreakers(job: DealBreakerJob, compiled: CompiledDealBreakers): string[] {
  const out: string[] = [];
  for (const rule of compiled.rules) if (dealBreakerHits(job, rule, compiled.matchTextMaxChars)) out.push(rule.rule.id);
  return out;
}

/** Why a rule vetoes a job, for the detail page and `deal-breakers:check`; computed when shown, never stored. */
export interface DealBreakerExplanation {
  id: string;
  type: DealBreaker["type"];
  /** Verbatim text of the job around the hit (C7): a substring of the title or of the description; null when there is none to show. */
  quote: string | null;
  /** Where `quote` comes from and where it starts. */
  field: "title" | "description" | null;
  offset: number | null;
  /** Language gate: the level the rules read in the posting, and the user's level (or the rule's `at_least`). */
  required?: GermanLevel;
  userLevel?: string;
  atLeast?: string;
}

/** The longest quote shown for a hit. */
const QUOTE_MAX_CHARS = 280;

/**
 * Explain a rule that vetoes `job` (null when it does not, or the rule is not active). A language gate quotes the sentence the
 * pipeline's rules read the level from (none when it is in the title or not found) and names both levels.
 */
export function explainDealBreaker(job: DealBreakerJob, rule: DealBreaker, context: DealBreakerContext, pipeline: PipelineConfig): DealBreakerExplanation | null {
  const compiled = compileDealBreakers([{ ...rule, enabled: true }], context).rules[0];
  if (!compiled || !dealBreakerHits(job, compiled, context.limits.match_text_max_chars)) return null;
  if (isGate(compiled)) {
    const level = job.germanLevel;
    const base: DealBreakerExplanation = { id: rule.id, type: rule.type, quote: null, field: null, offset: null, required: level };
    if (rule.type === "language_gate" && rule.at_least !== undefined) base.atLeast = rule.at_least;
    else if (context.me !== null && context.language !== null) base.userLevel = rankLabel(userLocalRank(context.me, context.language));
    const prefix = `${job.title}\n`;
    const span = job.description ? requiredLevelSpan(`${prefix}${job.description}`, level, pipeline) : null;
    if (span !== null && job.description && span.start >= prefix.length) {
      const { quote, offset } = sentenceAround(job.description, { start: span.start - prefix.length, end: span.end - prefix.length }, QUOTE_MAX_CHARS);
      return { ...base, quote, field: "description", offset };
    }
    return base;
  }
  const hit = phraseHit(job, compiled, context.limits.match_text_max_chars);
  if (hit === null) return null;
  const text = hit.field === "title" ? job.title : (job.description ?? "");
  const { quote, offset } = sentenceAround(text, hit, QUOTE_MAX_CHARS);
  return { id: rule.id, type: rule.type, quote, field: hit.field, offset };
}

/** A rule list over the limits of pipeline.yaml `filter.deal_breakers` (`path` is inside preferences.yaml `deal_breakers`). */
export interface DealBreakerLimitProblem {
  path: Array<string | number>;
  kind: "too_many_rules" | "pattern_too_long";
  max: number;
}

/** Where `rules` break the limits of pipeline.yaml (the schema only knows the hard upper bounds). Saving and `config:check` refuse these. */
export function dealBreakerLimitProblems(rules: readonly DealBreaker[], limits: PipelineConfig["filter"]["deal_breakers"]): DealBreakerLimitProblem[] {
  const problems: DealBreakerLimitProblem[] = [];
  if (rules.length > limits.max_rules) problems.push({ path: [], kind: "too_many_rules", max: limits.max_rules });
  rules.forEach((rule, index) => {
    if (rule.type !== "phrase") return;
    for (const field of ["terms", "patterns", "unless"] as const) {
      const at = rule[field].findIndex((text) => text.length > limits.max_pattern_chars);
      if (at !== -1) problems.push({ path: [index, field, at], kind: "pattern_too_long", max: limits.max_pattern_chars });
    }
  });
  return problems;
}

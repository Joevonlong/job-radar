import type { PipelineConfig } from "@/lib/config";
import { GERMAN_LEVELS, type GermanLevel, type JobLanguage } from "@/lib/domain/types";

import { compileRules, matchesAny, type CompiledLanguageRules } from "./rules";

// ---------------------------------------------------------------- text language

/** Share of stopwords below which a long text is in none of the known languages. */
const MIN_STOPWORD_SHARE = 0.08;

const stopwordSets = new WeakMap<PipelineConfig["language"]["stopwords"], Array<[string, Set<string>]>>();

function stopwordsOf(config: PipelineConfig): Array<[string, Set<string>]> {
  const table = config.language.stopwords;
  let sets = stopwordSets.get(table);
  if (!sets) {
    sets = Object.entries(table).map(([code, words]) => [code, new Set(words)]);
    stopwordSets.set(table, sets);
  }
  return sets;
}

function hintLanguage(hint: string | undefined, known: ReadonlyArray<string>): JobLanguage {
  if (hint === undefined) return "unknown";
  const code = hint.trim().toLowerCase().slice(0, 2);
  if (code === "" || hint.trim().toLowerCase() === "unknown") return "unknown";
  return known.includes(code) ? (code as JobLanguage) : "other";
}

/**
 * Language of the job description: the ISO code of a language the packs have stopwords for (`en`, `de` …), `other`,
 * or `unknown` when the text is too short to tell and the channel gave no hint. Detection is by stopword share; the
 * channel's hint is only used for short texts.
 */
export function detectLanguage(text: string, config: PipelineConfig, hint?: string): JobLanguage {
  const sets = stopwordsOf(config);
  const words = text.toLocaleLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < config.language.min_words_for_detection) return hintLanguage(hint, sets.map(([code]) => code));
  if (sets.length === 0) return "other";
  const counts = sets.map(([code, set]) => {
    let n = 0;
    for (const w of words) if (set.has(w)) n += 1;
    return { code, n };
  });
  // most stopwords first; a tie keeps the table order (generic English before the pack's language)
  const ranked = counts.map((c, index) => ({ ...c, index })).sort((a, b) => b.n - a.n || a.index - b.index);
  const best = ranked[0] as { code: string; n: number };
  if (best.n / words.length < MIN_STOPWORD_SHARE) return "other";
  return best.code as JobLanguage;
}

// ---------------------------------------------------------------- German level

const LEVEL_ORDER: readonly GermanLevel[] = GERMAN_LEVELS;

interface Clause {
  text: string;
  /** Offset of the clause in the whole text (section headings are searched before it). */
  start: number;
}

const CLAUSE_END = /[.;!?\n•·|]+|,(?!\d)/gu;

function clauses(text: string): Clause[] {
  const out: Clause[] = [];
  let from = 0;
  for (const m of text.matchAll(CLAUSE_END)) {
    out.push({ text: text.slice(from, m.index), start: from });
    from = m.index + m[0].length;
  }
  out.push({ text: text.slice(from), start: from });
  return out.filter((c) => c.text.trim() !== "");
}

type Span = { start: number; end: number };

function germanSpans(clause: string, lang: CompiledLanguageRules): Span[] {
  return [...clause.matchAll(lang.word)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

function distanceToSpans(spans: readonly Span[], start: number, end: number): number {
  return Math.min(...spans.map((s) => (start >= s.end ? start - s.end : end <= s.start ? s.start - end : 0)));
}

const globalOf = (pattern: RegExp): RegExp => new RegExp(pattern.source, "giu");

/** The clause with the text of `germanIgnore` ("German citizen") blanked out, so it holds no German word for that text. Offsets stay the same. */
function maskIgnored(clause: string, ignore: readonly RegExp[]): string {
  let masked = clause;
  for (const pattern of ignore) masked = masked.replace(globalOf(pattern), (m) => " ".repeat(m.length));
  return masked;
}

/** Whether a "nice to have" marker (plus, preferred, von Vorteil ...) stands close to the German word. */
function optionalNearGerman(clause: string, spans: readonly Span[], lang: CompiledLanguageRules): boolean {
  for (const pattern of lang.optional) {
    for (const m of clause.matchAll(globalOf(pattern))) {
      if (distanceToSpans(spans, m.index, m.index + m[0].length) <= lang.requirement.optional_max_distance) return true;
    }
  }
  return false;
}

const LIST_CONNECTOR = /^(?:[\s,&]|\b(?:and|or|und|oder)\b)+/iu;

/**
 * "German, Spanish, French or Italian are a plus": a comma ends the clause that holds German, but the
 * words that follow it are only more languages and the marker that closes the list. True when the
 * text after the clause (up to the end of the sentence) is such a list and starts a marker within reach.
 */
function listedAsOptional(fullText: string, clauseEnd: number, lang: CompiledLanguageRules): boolean {
  const names = lang.requirement.list_languages.map((n) => n.toLowerCase());
  const sentenceEnd = fullText.slice(clauseEnd).search(/[.;!?\n•·|:]/u);
  let rest = fullText.slice(clauseEnd, sentenceEnd === -1 ? fullText.length : clauseEnd + sentenceEnd);
  let consumed = 0;
  for (let guard = 0; guard < 20; guard += 1) {
    const connector = LIST_CONNECTOR.exec(rest)?.[0] ?? "";
    rest = rest.slice(connector.length);
    consumed += connector.length;
    const name = names.find((n) => rest.toLowerCase().startsWith(n) && !/[\p{L}]/u.test(rest.charAt(n.length)));
    if (name === undefined) break;
    rest = rest.slice(name.length);
    consumed += name.length;
  }
  if (consumed === 0) return false;
  return lang.optional.some((pattern) => {
    const m = globalOf(pattern).exec(rest);
    return m !== null && m.index <= lang.requirement.optional_max_distance;
  });
}

/** The end offset of the last match of any pattern that ends at or before `limit` in `text`, or -1. */
function lastHeadingEnd(patterns: readonly RegExp[], text: string, limit: number): number {
  let last = -1;
  for (const pattern of patterns) {
    for (const m of text.matchAll(globalOf(pattern))) {
      const end = m.index + m[0].length;
      if (end <= limit && end > last) last = end;
    }
  }
  return last;
}

/** Whether the German word at `position` sits under a "Preferred Qualifications" / "Nice to have" heading (the closest heading before it decides). */
function underPreferredHeading(fullText: string, position: number, lang: CompiledLanguageRules): boolean {
  const from = Math.max(0, position - lang.requirement.section_max_distance);
  const window = fullText.slice(from, position);
  const preferred = lastHeadingEnd(lang.preferredSection, window, window.length);
  if (preferred < 0) return false;
  // a tie is the same words matched by both lists ("Preferred Qualifications" also contains "Qualifications"): the preferred reading is the longer one
  return preferred >= lastHeadingEnd(lang.requiredSection, window, window.length);
}

const CEFR_LEVEL = /(?<![\p{L}\p{N}])([ABC][12])(?![\p{L}\p{N}])/iu;

/**
 * "C1-Deutschkenntnisse sind von Vorteil, B2-Niveau ist ausreichend": the comma ends the clause that
 * calls German a plus, but the rest of the sentence names the level that is enough, which is the
 * requirement. Looks at the text after the clause up to the end of the sentence for a CEFR level
 * followed by a "sufficient" word (the pack's `sufficient_patterns`).
 */
function sufficientLevelAfter(fullText: string, clauseEnd: number, lang: CompiledLanguageRules): GermanLevel | null {
  const sentenceEnd = fullText.slice(clauseEnd).search(/[.;!?\n•·|:]/u);
  const rest = fullText.slice(clauseEnd, sentenceEnd === -1 ? fullText.length : clauseEnd + sentenceEnd);
  for (const piece of rest.split(",")) {
    const level = CEFR_LEVEL.exec(piece)?.[1];
    if (level !== undefined && matchesAny(lang.sufficient, piece)) return level.toUpperCase() as GermanLevel;
  }
  return null;
}

/** `explicit`: the level is a CEFR level the text names ("German C1"), not a phrase ("fließend") that was read as one. */
type ClauseReading = { kind: "level"; level: GermanLevel; explicit: boolean } | { kind: "preferred" } | { kind: "none" } | null;

/** What one clause (which may mention German) says about the German the job needs. */
function readClause(clause: Clause, fullText: string, lang: CompiledLanguageRules): ClauseReading {
  const text = maskIgnored(clause.text, lang.ignore);
  const spans = germanSpans(text, lang);
  if (spans.length === 0) return null;
  if (matchesAny(lang.notRequired, text)) return { kind: "none" };
  if (optionalNearGerman(text, spans, lang)) {
    const enough = sufficientLevelAfter(fullText, clause.start + clause.text.length, lang);
    return enough === null ? { kind: "preferred" } : { kind: "level", level: enough, explicit: true };
  }
  // German is the last word of its clause and the list that goes on after the comma ends in "are a plus"
  const lastEnd = spans.at(-1)?.end ?? -1;
  if (lastEnd === text.trimEnd().length && listedAsOptional(fullText, clause.start + clause.text.length, lang)) return { kind: "preferred" };
  // under a "Preferred qualifications" heading, unless this very sentence says it is required
  if (!matchesAny(lang.requiredCue, text) && underPreferredHeading(fullText, clause.start + (spans[0]?.start ?? 0), lang)) return { kind: "preferred" };

  const cefr = lang.cefrAfter.exec(text)?.[1] ?? lang.cefrBefore.exec(text)?.[1];
  if (cefr !== undefined) return { kind: "level", level: cefr.toUpperCase() as GermanLevel, explicit: true };

  let best: { level: GermanLevel; distance: number; rank: number } | null = null;
  for (const [rank, rule] of lang.levelRules.entries()) {
    for (const m of text.matchAll(globalOf(rule.pattern))) {
      const distance = distanceToSpans(spans, m.index, m.index + m[0].length);
      if (distance > lang.requirement.level_max_distance) continue;
      if (best === null || distance < best.distance || (distance === best.distance && rank < best.rank)) {
        best = { level: rule.level, distance, rank };
      }
    }
  }
  return best === null ? null : { kind: "level", level: best.level, explicit: false };
}

/**
 * The German level a posting asks for, from its wording (rules in pipeline.yaml):
 * explicit CEFR levels ("German C1", "Deutsch B2"), phrases (fließend, verhandlungssicher, gute
 * Deutschkenntnisse, Grundkenntnisse, native), `preferred` when German is only a plus / preferred /
 * under a "Preferred qualifications" heading (never a requirement), `none` for "no German required",
 * and `unknown` when German is not mentioned with a level (C3). When several clauses disagree the
 * highest required level wins, then `preferred`, then `none`; AI cross-checks it later.
 */
export function extractGermanLevel(text: string, config: PipelineConfig): GermanLevel {
  const lang = compileRules(config).language;
  if (lang === null) return "unknown";
  let required: GermanLevel | null = null;
  let preferred = false;
  let none = false;
  for (const clause of clauses(text)) {
    const reading = readClause(clause, text, lang);
    if (reading === null) continue;
    if (reading.kind === "none") none = true;
    else if (reading.kind === "preferred") preferred = true;
    else if (required === null || LEVEL_ORDER.indexOf(reading.level) > LEVEL_ORDER.indexOf(required)) required = reading.level;
  }
  return required ?? (preferred ? "preferred" : none ? "none" : "unknown");
}

/**
 * The CEFR levels the text names as a requirement ("German C1 required", "Deutsch B2"): explicit
 * levels in clauses that are not "a plus" / "preferred" / "not required". The scorer uses it to decide
 * which of two readings (rule, AI) the JD states more explicitly; a level that only appears next to
 * "nice to have" is not a statement of what the job needs.
 */
export function explicitRequiredGermanLevels(text: string, config: PipelineConfig): Set<GermanLevel> {
  const found = new Set<GermanLevel>();
  const lang = compileRules(config).language;
  if (lang === null) return found;
  for (const clause of clauses(text)) {
    const reading = readClause(clause, text, lang);
    if (reading?.kind === "level" && reading.explicit) found.add(reading.level);
  }
  return found;
}

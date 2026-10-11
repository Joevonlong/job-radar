/**
 * Instructions addressed to an AI ("if you are an AI, ...", "ignore all previous instructions", "如果你是AI，请...") and the weaker
 * trigger patterns. The patterns live in traps.yaml (C8), grouped by language; only the groups of
 * `instruction_languages` are used.
 */
import type { TrapPatternConfig, TrapsConfig } from "@/lib/config/schemas/traps";

import type { RawFinding } from "./types";

export interface CompiledPattern {
  id: string;
  lang: string;
  regex: RegExp;
}

const cache = new WeakMap<readonly TrapPatternConfig[], Map<string, CompiledPattern[]>>();

/** The patterns of the given languages, compiled with the global flag (cached per config object). */
export function compilePatterns(list: readonly TrapPatternConfig[], languages: readonly string[]): CompiledPattern[] {
  const key = languages.join(",");
  let byLang = cache.get(list);
  if (!byLang) {
    byLang = new Map();
    cache.set(list, byLang);
  }
  const hit = byLang.get(key);
  if (hit) return hit;
  const wanted = new Set(languages);
  const compiled = list
    .filter((p) => wanted.has(p.lang))
    .map((p) => {
      const flags = new Set([...p.flags, "g", "u"]);
      return { id: p.id, lang: p.lang, regex: new RegExp(p.pattern, [...flags].join("")) };
    });
  byLang.set(key, compiled);
  return compiled;
}

export interface InstructionHit {
  id: string;
  start: number;
  end: number;
}

/** Every instruction-pattern hit in `text`, in text order (overlapping hits of different patterns are all kept). */
export function findPatternHits(text: string, patterns: readonly CompiledPattern[]): InstructionHit[] {
  const hits: InstructionHit[] = [];
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    for (const match of text.matchAll(pattern.regex)) {
      if (match[0] === "") continue;
      const start = match.index ?? 0;
      hits.push({ id: pattern.id, start, end: start + match[0].length });
    }
  }
  return hits.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function instructionPatterns(settings: TrapsConfig): CompiledPattern[] {
  return compilePatterns(settings.instructions, settings.instruction_languages);
}

export function triggerPatterns(settings: TrapsConfig): CompiledPattern[] {
  return compilePatterns(settings.ai_check.triggers, settings.instruction_languages);
}

/** Id of the first instruction pattern `text` matches, or null. */
export function firstInstruction(text: string, settings: TrapsConfig): string | null {
  return findPatternHits(text, instructionPatterns(settings))[0]?.id ?? null;
}

/** Id of the first trigger pattern `text` matches, or null. */
export function firstTrigger(text: string, settings: TrapsConfig): string | null {
  return findPatternHits(text, triggerPatterns(settings))[0]?.id ?? null;
}

/** Characters that end a sentence (Latin and CJK). */
const SENTENCE_END = /[.!?。！？]/u;
const LIST_MARKER = /^(?:[-*•–·]\s+|\d{1,3}[.)]\s+|#{1,6}\s+)/u;

/**
 * The sentence of `text` around a hit: back to the previous sentence end or line break, forward through the next sentence end
 * (included) or to the line end; trimmed, without a list marker; at most `maxChars` (cut around the hit). A verbatim substring.
 */
export function sentenceOf(text: string, hit: { start: number; end: number }, maxChars: number): { quote: string; offset: number } {
  let start = hit.start;
  while (start > 0) {
    const ch = text.charAt(start - 1);
    if (ch === "\n") break;
    // "85.000" or "e.g." inside a sentence: only a mark followed by whitespace (or a CJK mark) ends one
    if (SENTENCE_END.test(ch) && (/[。！？]/u.test(ch) || /\s/u.test(text.charAt(start)))) break;
    start -= 1;
  }
  let end = hit.end;
  while (end < text.length) {
    const ch = text.charAt(end);
    if (ch === "\n") break;
    end += 1;
    if (SENTENCE_END.test(ch) && (/[。！？]/u.test(ch) || end === text.length || /\s/u.test(text.charAt(end)))) break;
  }
  while (start < end && /\s/u.test(text.charAt(start))) start += 1;
  while (end > start && /\s/u.test(text.charAt(end - 1))) end -= 1;
  const marker = LIST_MARKER.exec(text.slice(start, end));
  if (marker && start + marker[0].length <= hit.start) start += marker[0].length;
  if (end - start > maxChars) {
    const room = Math.max(0, maxChars - (hit.end - hit.start));
    start = Math.max(start, hit.start - Math.floor(room / 2));
    end = Math.min(end, start + maxChars);
  }
  return { quote: text.slice(start, end), offset: start };
}

/**
 * The instructions of a text, one finding per sentence (several patterns hitting one sentence make one finding).
 * Severity is always `trap`: text that addresses an AI is a trap whether it is visible or hidden.
 */
export function scanInstructions(text: string, settings: TrapsConfig, path: string): RawFinding[] {
  const out: RawFinding[] = [];
  for (const hit of findPatternHits(text, instructionPatterns(settings))) {
    const sentence = sentenceOf(text, hit, Math.max(settings.scan.quote_max_chars, hit.end - hit.start));
    if (sentence.quote.trim() === "") continue;
    const end = sentence.offset + sentence.quote.length;
    if (out.some((f) => f.offset !== null && sentence.offset < f.offset + f.text.length && end > f.offset)) continue;
    out.push({ technique: "instruction", method: null, severity: "trap", text: sentence.quote, path, offset: sentence.offset, evidence: null, instructionId: hit.id, detail: {} });
  }
  return out;
}

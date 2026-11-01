/**
 * Finding an answer worth starting from: finalised answers to other jobs' questions that read like a new question, ranked
 * by the share of words they have in common. All local text work (client-safe, no AI call). Words are compared as
 * written, so the same question in another language does not match.
 */
import { containsWords, normalize } from "./verify";

/** The distinct words of a question: letters and digits, accents and case folded; every CJK character is a word of its own. */
export function questionTokens(text: string): Set<string> {
  const folded = normalize(text);
  const words = folded.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];
  return new Set(words);
}

/** Share of the words two questions have in common (Jaccard, 0..1); 0 when either has no words. */
export function similarity(a: string, b: string): number {
  const left = questionTokens(a);
  const right = questionTokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export interface SimilarCandidate {
  /** The earlier question's text. */
  text: string;
}

/**
 * The candidates whose question is at least `minSimilarity` like `text`, the most similar first (a tie keeps the order
 * given, so pass the newest first), at most `maxCandidates`.
 */
export function rankSimilar<T extends SimilarCandidate>(text: string, candidates: readonly T[], limits: { minSimilarity: number; maxCandidates: number }): (T & { similarity: number })[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, similarity: similarity(text, candidate.text) }))
    .filter((entry) => entry.similarity >= limits.minSimilarity)
    .sort((a, b) => b.similarity - a.similarity || a.index - b.index)
    .slice(0, Math.max(0, limits.maxCandidates))
    .map((entry) => ({ ...entry.candidate, similarity: entry.similarity }));
}

/** The shortest company spelling (in characters, after folding) that is looked for in a text: a one-letter name would match anywhere. */
const MIN_COMPANY_CHARS = 2;

/** A company as the warning knows it: the name to show (as stored) and the spellings to look for (`companyMatchNames`). */
export interface CompanyNames {
  company: string;
  names: readonly string[];
}

/** ß as ss, then the comparison form of `normalize` (the pipeline's company key spells ß that way too). */
const spelled = (text: string): string => text.replace(/[ßẞ]/gu, "ss");

/**
 * The companies of `companies` that the text names as whole words under any of their spellings (case and accents
 * ignored), each once, in the order given, shown by the name as stored. Used to warn that an answer started from the one
 * for another company still names that company.
 */
export function mentionedCompanies(text: string, companies: readonly CompanyNames[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const haystack = spelled(text);
  for (const entry of companies) {
    const key = normalize(spelled(entry.company));
    if (seen.has(key)) continue;
    seen.add(key);
    if (entry.names.some((name) => normalize(spelled(name)).length >= MIN_COMPANY_CHARS && containsWords(haystack, spelled(name)))) out.push(entry.company);
  }
  return out;
}

/** The text of an earlier final answer a new question is started from, waiting in the editor until it is saved as a version. */
export interface ReuseBase {
  /** The new question the text is for. */
  questionId: number;
  /** The earlier final version it was taken from. */
  sourceVersionId: number;
  text: string;
  company: string;
  /** The spellings of the company to look for in the text. */
  companyNames: readonly string[];
  jobTitle: string;
}

/**
 * The companies of `from` that `text` still names, leaving out this job's own company (an earlier answer for the same
 * company is not out of place; the two are the same company when they share a spelling, so "Acme GmbH" and "Acme Inc."
 * count as one). Empty when the text names none of them.
 */
export function staleCompanies(text: string, from: readonly CompanyNames[], currentNames: readonly string[]): string[] {
  const own = new Set(currentNames.map((name) => normalize(spelled(name))));
  return mentionedCompanies(
    text,
    from.filter((entry) => !entry.names.some((name) => own.has(normalize(spelled(name))))),
  );
}

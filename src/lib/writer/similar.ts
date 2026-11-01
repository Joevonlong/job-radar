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

/** The shortest company name (in characters, after folding) that is looked for in a text: a one-letter name would match anywhere. */
const MIN_COMPANY_CHARS = 2;

/**
 * The names of `companies` that the text mentions as whole words (case and accents ignored), each once, in the order given.
 * Used to warn that an answer started from the one for another company still names that company.
 */
export function mentionedCompanies(text: string, companies: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const company of companies) {
    const key = normalize(company);
    if (key.length < MIN_COMPANY_CHARS || seen.has(key)) continue;
    seen.add(key);
    if (containsWords(text, company)) out.push(company);
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
  jobTitle: string;
}

/**
 * The companies of `from` that `text` still names, leaving out this job's own company (an earlier answer for the same
 * company is not out of place). Empty when the text names none of them.
 */
export function staleCompanies(text: string, from: readonly { company: string }[], currentCompany: string): string[] {
  const current = normalize(currentCompany);
  return mentionedCompanies(
    text,
    from.map((entry) => entry.company).filter((company) => normalize(company) !== current),
  );
}

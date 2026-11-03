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

/**
 * Share of the words two questions have in common (Jaccard, 0..1); 0 when either has no words. `stopwords` (`reuse.stopwords`) are left
 * out, unless that would leave one of the questions without words: it is then compared as written.
 */
export function similarity(a: string, b: string, stopwords: readonly string[] = []): number {
  const stop = new Set(stopwords.flatMap((word) => [...questionTokens(word)]));
  const without = (tokens: Set<string>): Set<string> => new Set([...tokens].filter((word) => !stop.has(word)));
  const written = [questionTokens(a), questionTokens(b)] as const;
  const filtered = [without(written[0]), without(written[1])] as const;
  const [left, right] = filtered[0].size > 0 && filtered[1].size > 0 ? filtered : written;
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
export function rankSimilar<T extends SimilarCandidate>(text: string, candidates: readonly T[], limits: { minSimilarity: number; maxCandidates: number; stopwords?: readonly string[] }): (T & { similarity: number })[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, similarity: similarity(text, candidate.text, limits.stopwords) }))
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

/** Accents folded and ß as ss, the case kept. */
const folded = (text: string): string => spelled(text).normalize("NFKD").replace(/\p{M}/gu, "");
const CJK_NEIGHBOUR = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;
/** Names this short are often ordinary words in any language (It, On, Go). */
const SHORT_NAME_CHARS = 3;

/**
 * Does the text name the company under this spelling? A name that looks like an ordinary word must not fire on that word: up to three
 * letters it counts only exactly as stored and, unless all capitals, not as the first word of a sentence ("It is ..."); a longer plain
 * word counts only with a capital (Target, not "our target"). Any other name (GitLab, two words) is compared ignoring case.
 */
function names(text: string, spelling: string, stored: string): boolean {
  const lowered = folded(spelling);
  // the spelling without the legal form is stored in lower case: its case comes from the stored name
  const name = folded(stored).match(new RegExp(lowered.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`), "iu"))?.[0] ?? lowered;
  const short = /^\p{L}+$/u.test(name) && [...name].length <= SHORT_NAME_CHARS;
  if (!short && !/^\p{Lu}?\p{Ll}+$/u.test(name)) return containsWords(spelled(text), spelling);
  const haystack = folded(text);
  const pattern = new RegExp(String.raw`(?<=^|[^\p{L}\p{N}]|[${CJK_NEIGHBOUR}])${name}(?=$|[^\p{L}\p{N}]|[${CJK_NEIGHBOUR}])`, "giu");
  for (const match of haystack.matchAll(pattern)) {
    if (!short) {
      if (/^\p{Lu}/u.test(match[0])) return true;
      continue;
    }
    if (match[0] !== name) continue;
    const opensSentence = /(?:^|[.!?。！？:;\n]["'”’)]?)\s*$/u.test(haystack.slice(0, match.index));
    if (name.toUpperCase() === name || !opensSentence) return true;
  }
  return false;
}

/**
 * The companies of `companies` that the text names as whole words under any of their spellings (accents ignored, case per
 * `names`), each once, in the order given, shown by the name as stored. Used to warn that an answer started from the one
 * for another company still names that company.
 */
export function mentionedCompanies(text: string, companies: readonly CompanyNames[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of companies) {
    const key = normalize(spelled(entry.company));
    if (seen.has(key)) continue;
    seen.add(key);
    if (entry.names.some((name) => normalize(spelled(name)).length >= MIN_COMPANY_CHARS && names(text, name, entry.company))) out.push(entry.company);
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

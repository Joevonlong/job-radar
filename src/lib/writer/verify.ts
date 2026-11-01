/**
 * The evidence check of an application answer: deterministic, no AI call. Each sentence's quotes are looked up in the
 * material they name, the sources a sentence may rest on are limited by what it is about, and every figure, known
 * technology / company name and name-like word of the sentence must be in its valid quotes. It marks what to check; it
 * cannot tell whether a sentence is true (a quote found is not a fact verified).
 */
import type { WriterEvidenceConfig } from "@/lib/config/schemas/writer";
import { locateQuote } from "@/lib/signals/quote";

import type { CheckedEvidence, CheckedSentence, EvidenceProblem, EvidenceSource, SentenceAbout, SentenceStatus, StatusCounts } from "./types";

/** What the sentences are checked against: the raw JD and the snapshot of the material sent. */
export interface VerifyContext {
  /** The stored (raw) JD; `jd` quotes are looked up here, as the breakdown does. */
  jd: string;
  profile: string | null;
  /** Story id -> the story as one text. */
  stories: ReadonlyMap<string, string>;
  emphasis: string | null;
  /** The user's own draft (a later writing mode). */
  draft: string | null;
  /** The company background (AI web search, a later step). */
  company: string | null;
  /** Technology and company names whose mention must be backed by the sentence's quotes. */
  entities: readonly string[];
  /** The job's company: a sentence naming it is backed by any valid JD (or company background) quote. */
  companyName: string;
  /** The answer's language (ISO 639 / BCP 47): picks the first-person words and the name rule. */
  language: string;
  config: WriterEvidenceConfig;
}

export interface RawSentence {
  text: string;
  about: SentenceAbout;
  newParagraph?: boolean;
  evidence: ReadonlyArray<{ source: EvidenceSource; ref?: string | undefined; quote: string }>;
}

/** The sources a sentence may rest on, by what it is about (`framing` with facts may rest on anything). */
const ALLOWED: Record<SentenceAbout, ReadonlySet<EvidenceSource>> = {
  user: new Set(["profile", "story", "emphasis", "draft"]),
  company: new Set(["jd", "company"]),
  role: new Set(["jd"]),
  framing: new Set(["jd", "profile", "story", "emphasis", "draft", "company"]),
};

// ---------------------------------------------------------------- text normalisation

/** Lower case, accents folded, quotes and dashes unified, whitespace collapsed: how quotes and names are compared. */
export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[‘’‚‛`´]/gu, "'")
    .replace(/[“”„‟«»「」『』]/gu, '"')
    .replace(/[‐‑‒–—―]/gu, "-")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

function primaryLanguage(code: string): string {
  return code.toLowerCase().split(/[-_]/)[0] ?? code.toLowerCase();
}

const FIGURE = String.raw`(?<![\p{L}\p{N}])(\d{1,3}(?:[.,\u00a0\u202f ]\d{3})+|\d+)(?:[.,](\d+))?\s*(k)?(?![\p{L}\p{N}])(\s*(?:%|percent|per cent|prozent|pct)(?!\p{L}))?`;
const figurePattern = (): RegExp => new RegExp(FIGURE, "giu");
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const WORD = /[\p{L}\p{N}](?:[\p{L}\p{N}+#]|['’.\-&](?=[\p{L}\p{N}]))*/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

interface Token {
  text: string;
  start: number;
  end: number;
}

/** The words of a text, with CJK characters treated as separators (they carry no capitals and need no spaces). */
function tokens(text: string): Token[] {
  const latin = text.replace(CJK, " ");
  return [...latin.matchAll(WORD)].map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
}

/** `needle` occurs in `haystack` as whole words (both normalised). */
export function containsWords(haystack: string, needle: string): boolean {
  const n = normalize(needle);
  if (n === "") return false;
  const h = normalize(haystack);
  let from = 0;
  for (;;) {
    const at = h.indexOf(n, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : h.charAt(at - 1);
    const after = h.charAt(at + n.length);
    const edge = (char: string): boolean => char === "" || !/[\p{L}\p{N}]/u.test(char) || CJK_CHAR.test(char);
    if (edge(before) && edge(after)) return true;
    from = at + 1;
  }
}

// ---------------------------------------------------------------- figures

/**
 * The figures of a text, normalised so that the same amount matches across languages and notations: `40 %`, `40%`,
 * `40 percent` and `40 Prozent` all give `40%`; `€85k`, `85,000 €` and `85.000 €` give `85000`. A separator followed by
 * exactly three digits is a thousands separator, otherwise a decimal mark. A percentage also matches its bare number.
 * Figures written as words ("forty") are not recognised. Digits inside a word (S3, K8s) are names, not figures.
 */
export function figures(text: string): { keys: Set<string>; shown: string[] } {
  const keys = new Set<string>();
  const shown: string[] = [];
  for (const match of text.matchAll(figurePattern())) {
    const [whole, intPart = "", decimals, thousand, percentMark] = match;
    const digits = intPart.replace(/[.,\u00a0\u202f ]/g, "");
    let value = Number(decimals === undefined ? digits : `${digits}.${decimals}`);
    if (!Number.isFinite(value)) continue;
    if (thousand) value *= 1000;
    const key = `${Number(value.toFixed(6))}`;
    const percent = percentMark !== undefined && percentMark.trim() !== "";
    keys.add(percent ? `${key}%` : key);
    if (percent) keys.add(key);
    shown.push(whole.trim());
  }
  return { keys, shown };
}

/** The figures of a sentence that its evidence text does not contain (shown as written in the sentence). */
function missingFigures(sentence: string, evidence: string): string[] {
  const have = figures(evidence).keys;
  const out: string[] = [];
  for (const match of sentence.matchAll(figurePattern())) {
    const { keys } = figures(match[0]);
    const percentKey = [...keys].find((key) => key.endsWith("%"));
    const wanted = percentKey ?? [...keys][0];
    if (wanted !== undefined && !have.has(wanted)) out.push(match[0].trim());
  }
  return out;
}

// ---------------------------------------------------------------- first person, names

/** Does the sentence speak about the writer (`evidence.first_person` of its language)? */
export function isFirstPerson(text: string, language: string, config: WriterEvidenceConfig): boolean {
  const lists = config.first_person;
  const own = lists[primaryLanguage(language)];
  const check = (entry: (typeof lists)[string]): boolean => {
    if (Array.isArray(entry)) {
      const words = new Set(entry.map((word) => normalize(word)));
      return tokens(text).some((token) => words.has(normalize(token.text)));
    }
    let rest = text;
    for (const exclude of entry.exclude) rest = rest.split(exclude).join(" ");
    return entry.words.some((word) => rest.includes(word));
  };
  return own !== undefined ? check(own) : Object.values(lists).some(check);
}

const QUOTED = /"([^"\n]{2,80})"|“([^”\n]{2,80})”|„([^“”\n]{2,80})[“”]|«([^»\n]{2,80})»|「([^」\n]{2,80})」|『([^』\n]{2,80})』/gu;

/**
 * Words of a sentence that look like names (`evidence.names`): quoted names; words with digits, inner capitals or all
 * capitals; capitalised words that do not open the sentence (runs of them as one name; with `multi`, only runs of two or
 * more). Stopwords and the language's first-person words never count. Lower-case names are not found.
 */
export function nameCandidates(text: string, language: string, config: WriterEvidenceConfig): string[] {
  const rules = config.names;
  const out: string[] = [];
  const stop = new Set(rules.stopwords);
  const firstPersonList = config.first_person[primaryLanguage(language)];
  const firstPerson = new Set(Array.isArray(firstPersonList) ? firstPersonList.map((word) => normalize(word)) : []);
  const skip = (word: string): boolean => stop.has(word) || firstPerson.has(normalize(word));
  if (rules.quoted) {
    for (const match of text.matchAll(QUOTED)) {
      const name = match.slice(1).find((group) => group !== undefined)?.trim();
      if (name) out.push(name);
    }
  }
  const words = tokens(text);
  const opening = text.search(/[\p{L}\p{N}]/u);
  const rule = rules.capitalized_non_initial[primaryLanguage(language)] ?? rules.capitalized_non_initial.default ?? "single";
  const isMixed = (word: string): boolean =>
    /\p{L}/u.test(word) && (/\p{N}/u.test(word) || /\p{Ll}\p{Lu}/u.test(word) || (/^[\p{Lu}\p{N}+#&.\-]{2,}$/u.test(word) && /\p{Lu}.*\p{Lu}/u.test(word)));
  const isCapitalised = (word: string): boolean => /^\p{Lu}/u.test(word);
  let run: Token[] = [];
  const flush = (): void => {
    if (run.length > 0 && rule !== "off" && (rule === "single" || run.length >= 2)) {
      out.push(text.slice(run[0]!.start, run[run.length - 1]!.end));
    }
    run = [];
  };
  for (const token of words) {
    if (skip(token.text)) {
      flush();
      continue;
    }
    if (rules.mixed_tokens && isMixed(token.text)) {
      flush();
      out.push(token.text);
      continue;
    }
    const atStart = token.start === opening;
    if (isCapitalised(token.text) && !atStart) {
      const previous = run[run.length - 1];
      if (previous && !/^\s+$/u.test(text.slice(previous.end, token.start))) flush();
      run.push(token);
      continue;
    }
    flush();
  }
  flush();
  return [...new Set(out)];
}

// ---------------------------------------------------------------- evidence lookup

function sourceText(context: VerifyContext, source: EvidenceSource): string | null {
  switch (source) {
    case "profile":
      return context.profile;
    case "emphasis":
      return context.emphasis;
    case "draft":
      return context.draft;
    case "company":
      return context.company;
    case "jd":
      return context.jd;
    case "story":
      return null;
  }
}

/** Why one evidence entry does not count for a sentence about `about`, or null when it does. */
function evidenceProblem(context: VerifyContext, about: SentenceAbout, entry: { source: EvidenceSource; ref?: string | undefined; quote: string }): EvidenceProblem | null {
  // A quote of a letter or two matches almost anything; a known name (Go, R) still counts as written.
  const quote = entry.quote.trim();
  if ([...quote].length < context.config.min_quote_chars && !context.entities.some((entity) => entity.trim() === quote)) return "too_short";
  let found: boolean;
  if (entry.source === "story") {
    if (entry.ref === undefined || entry.ref.trim() === "") return "no_ref";
    const story = context.stories.get(entry.ref.trim());
    if (story === undefined) return "unknown_ref";
    found = normalize(story).includes(normalize(entry.quote));
  } else if (entry.source === "jd") {
    found = locateQuote(context.jd, entry.quote) !== null || normalize(context.jd).includes(normalize(entry.quote));
  } else {
    const text = sourceText(context, entry.source);
    found = text !== null && normalize(entry.quote) !== "" && normalize(text).includes(normalize(entry.quote));
  }
  if (!found) return "not_found";
  return ALLOWED[about].has(entry.source) ? null : "not_allowed";
}

// ---------------------------------------------------------------- one sentence

/** Check one sentence (see the module comment). */
export function verifySentence(raw: RawSentence, context: VerifyContext): CheckedSentence {
  const named = [...new Set(context.entities)].filter((entity) => entity.trim().length >= 2 && mentions(raw.text, entity));
  const candidates = nameCandidates(raw.text, context.language, context.config);
  const hasFacts = figures(raw.text).shown.length > 0 || named.length > 0 || candidates.length > 0;
  // A first-person sentence is one about you whatever its label; a linking sentence without facts ("that is why this
  // role appeals to me") states nothing to check and stays framing.
  const firstPerson = isFirstPerson(raw.text, context.language, context.config);
  const about: SentenceAbout = firstPerson && (raw.about !== "framing" || hasFacts) ? "user" : raw.about;
  const evidence: CheckedEvidence[] = raw.evidence.map((entry) => ({
    source: entry.source,
    ...(entry.ref !== undefined && entry.ref.trim() !== "" ? { ref: entry.ref.trim() } : {}),
    quote: entry.quote,
    problem: evidenceProblem(context, about, entry),
  }));
  const valid = evidence.filter((entry) => entry.problem === null);
  const quotes = valid.map((entry) => entry.quote).join("\n");

  // figures and known names of the sentence that its valid quotes do not contain
  const missing: string[] = [...missingFigures(raw.text, quotes)];
  const backsCompany = valid.some((entry) => entry.source === "jd" || entry.source === "company");
  for (const entity of named) {
    if (entity === context.companyName && backsCompany) continue;
    if (!mentions(quotes, entity)) missing.push(entity);
  }
  // name-like words not found where the sentence may rest: for a claim about you only the valid quotes (a tool named in
  // the JD is not one you used), otherwise also the JD and the company background
  const lookIn = about === "user" ? quotes : [quotes, context.jd, context.company ?? ""].join("\n");
  const needsCheck = candidates.filter((name) => !containsWords(lookIn, name) && !missing.some((entry) => normalize(entry) === normalize(name)));

  let status: SentenceStatus;
  if (about === "framing" && !hasFacts) status = "framing";
  else if (valid.length === 0) status = "unsupported";
  else if (missing.length > 0 || needsCheck.length > 0) status = "partial";
  else if (valid.every((entry) => entry.source === "company")) status = "web_unverified";
  else status = "supported";
  return { text: raw.text, newParagraph: raw.newParagraph ?? false, about, status, evidence, missing: [...new Set(missing)], needsCheck };
}

/**
 * The sentence names `entity` as whole words. Short names (up to three characters: Go, R, C#) only count with the case
 * they are written in, so the verb "go" is not the language Go; longer ones are compared case- and accent-insensitively.
 */
function mentions(text: string, entity: string): boolean {
  const name = entity.trim();
  if (name.length <= 3) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(text);
  }
  return containsWords(text, name);
}

// ---------------------------------------------------------------- versions

export function countStatuses(sentences: readonly Pick<CheckedSentence, "status">[]): StatusCounts {
  const counts: StatusCounts = { supported: 0, partial: 0, unsupported: 0, framing: 0, user_written: 0, web_unverified: 0 };
  for (const sentence of sentences) {
    switch (sentence.status) {
      case "supported":
      case "partial":
      case "unsupported":
      case "framing":
      case "user_written":
      case "web_unverified":
        counts[sentence.status] += 1;
        break;
      // the statuses of later modes count as unverified
      case "ai_suggestion_unverified":
      case "external_unverified":
        counts.unsupported += 1;
        break;
    }
  }
  return counts;
}

/** The text of a version from its sentences: spaces between sentences, a blank line before a new paragraph. */
export function joinSentences(sentences: readonly Pick<CheckedSentence, "text" | "newParagraph">[]): string {
  return sentences.reduce((out, sentence, index) => (index === 0 ? sentence.text : `${out}${sentence.newParagraph ? "\n\n" : " "}${sentence.text}`), "");
}

export function verifySentences(raw: readonly RawSentence[], context: VerifyContext): CheckedSentence[] {
  return raw.map((sentence) => verifySentence(sentence, context));
}

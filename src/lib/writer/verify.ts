/**
 * The evidence check of an application answer: deterministic, no AI call. Each sentence's quotes are looked up in the
 * material they name, the sources a sentence may rest on are limited by what it is about, and every figure, known
 * technology / company name and name-like word of the sentence must be in its valid quotes. It marks what to check; it
 * cannot tell whether a sentence is true (a quote found is not a fact verified).
 */
import { defaultFigureUnits, type WriterEvidenceConfig } from "@/lib/config/schemas/writer";
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
  /** The ticked fields of the company background (AI web search). */
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

// CJK text has no spaces: a figure may sit directly against Han, kana or Hangul characters ("下降了40%的"), unlike one against Latin letters (S3, K8s).
const CJK_CLASS = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;
type FigureUnits = WriterEvidenceConfig["figure_units"];
/** How units are compared: text is read in NFKC and a unit's case does not count, so `㎏`, `kg` and `KG` are one unit, in the file and in the text. */
const foldUnit = (unit: string): string => unit.normalize("NFKC").toLowerCase();
const escapeRegExp = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
const ONLY_CJK = new RegExp(`^[${CJK_CLASS}]+$`, "u");
const anyOf = (words: readonly string[]): string =>
  [...words]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
/** The configured units in the form they are compared in. */
function foldedUnits(units: FigureUnits): { scale: Map<string, number>; multiple: Set<string>; words: string[] } {
  const scale = new Map(Object.entries(units.scale).map(([word, factor]) => [foldUnit(word), factor]));
  const multiple = new Set(units.multiple.map(foldUnit));
  return { scale, multiple, words: [...scale.keys(), ...multiple] };
}
/**
 * The figure pattern; its fourth group is what follows the digits of `evidence.figure_units` (none when none are configured). CJK units
 * may stand in a row (3千万); a Latin one stands alone, so 5mm is not two units.
 */
const figurePattern = (words: readonly string[]): RegExp => {
  const cjk = words.filter((word) => ONLY_CJK.test(word));
  const other = words.filter((word) => !ONLY_CJK.test(word));
  // a one-letter Latin unit (5M, 5x) must stand against the digits: "5 m" is five metres or minutes as often as five million
  const spaced = other.filter((word) => word.length > 1);
  const attached = other.filter((word) => word.length === 1);
  const alternatives = [
    ...(cjk.length > 0 ? [String.raw`\s*(?:${anyOf(cjk)})+`] : []),
    ...(spaced.length > 0 ? [String.raw`\s*(?:${anyOf(spaced)})`] : []),
    ...(attached.length > 0 ? [anyOf(attached)] : []),
  ];
  const unit = alternatives.length > 0 ? `(${alternatives.join("|")})?` : "()";
  return new RegExp(
    String.raw`(?<=^|[^\p{L}\p{N}]|[${CJK_CLASS}])(\d{1,3}(?:[.,\u00a0\u202f ]\d{3})+|\d+)(?:[.,](\d+))?(?:\s*(k(?![a-z])))?${unit}(?=$|[^\p{L}\p{N}]|[${CJK_CLASS}])(\s*(?:%|percent|per cent|prozent|pct)(?!(?![${CJK_CLASS}])\p{L}))?`,
    "giu",
  );
};
/**
 * A text as figures are read from it: NFKC, and an amount with thousands separators set apart from a currency code written against it
 * (EUR50,000, 50,000EUR). Other digits against letters stay part of a word (S3, K8s).
 */
const figureText = (text: string): string =>
  text
    .normalize("NFKC")
    .replace(/(?<![\p{L}\p{N}])(\p{Lu}{2,})(\d{1,3}(?:[.,]\d{3})+)/gu, "$1 $2")
    .replace(/(\d{1,3}(?:[.,]\d{3})+)([A-Za-z]{2,})(?![\p{L}\p{N}])/gu, "$1 $2");
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
 * Full-width digits and marks (５００％) are read as ASCII. A magnitude unit right after a figure scales it (5万 is 50,000,
 * 3千万 is 30,000,000) and 倍 makes it a multiple that matches only a multiple (40倍 is not 40%). Figures written as words
 * ("forty", "四十") are not recognised. Digits inside a word (S3, K8s) are names, not figures.
 */
export function figures(text: string, units: FigureUnits = defaultFigureUnits()): { keys: Set<string>; shown: string[] } {
  const keys = new Set<string>();
  const shown: string[] = [];
  const folded = foldedUnits(units);
  const unitWord = folded.words.length > 0 ? new RegExp(anyOf(folded.words), "gu") : null;
  for (const match of figureText(text).matchAll(figurePattern(folded.words))) {
    const [whole, intPart = "", decimals, thousand, unit, percentMark] = match;
    const digits = intPart.replace(/[.,\u00a0\u202f ]/g, "");
    let value = Number(decimals === undefined ? digits : `${digits}.${decimals}`);
    if (!Number.isFinite(value)) continue;
    if (thousand) value *= 1000;
    const unitWords = unit === undefined || unit === "" || unitWord === null ? [] : (foldUnit(unit).match(unitWord) ?? []);
    for (const word of unitWords) value *= folded.scale.get(word) ?? 1;
    const key = `${Number(value.toFixed(6))}`;
    // "3倍" is a multiple, not an amount: it matches only a multiple
    if (unitWords.some((word) => folded.multiple.has(word))) {
      keys.add(`${key}x`);
      shown.push(whole.trim());
      continue;
    }
    const percent = percentMark !== undefined && percentMark.trim() !== "";
    keys.add(percent ? `${key}%` : key);
    if (percent) keys.add(key);
    shown.push(whole.trim());
  }
  return { keys, shown };
}

/** The figures of a sentence that its evidence text does not contain (shown as written in the sentence). */
export function missingFigures(sentence: string, evidence: string, units: FigureUnits): string[] {
  const have = figures(evidence, units).keys;
  const out: string[] = [];
  for (const match of figureText(sentence).matchAll(figurePattern(foldedUnits(units).words))) {
    const { keys } = figures(match[0], units);
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
  const hasFacts = figures(raw.text, context.config.figure_units).shown.length > 0 || named.length > 0 || candidates.length > 0;
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
  const missing: string[] = [...missingFigures(raw.text, quotes, context.config.figure_units)];
  const backsCompany = valid.some((entry) => entry.source === "jd" || entry.source === "company");
  for (const entity of named) {
    if (entity === context.companyName && backsCompany) continue;
    if (!mentions(quotes, entity)) missing.push(entity);
  }
  const citesWeb = valid.some((entry) => entry.source === "company");
  // name-like words not found where the sentence may rest: for a claim about you only the valid quotes (a tool named in
  // the JD is not one you used), otherwise also the JD, and the company background only for a sentence that cites it: a name that
  // is merely somewhere in the ticked web text must not pass in a sentence that then counts as backed
  const lookIn = about === "user" ? quotes : [quotes, context.jd, citesWeb ? (context.company ?? "") : ""].join("\n");
  const needsCheck = candidates.filter((name) => !containsWords(lookIn, name) && !missing.some((entry) => normalize(entry) === normalize(name)));

  let status: SentenceStatus;
  if (about === "framing" && !hasFacts && !citesWeb) status = "framing";
  else if (valid.length === 0) status = "unsupported";
  else if (missing.length > 0 || needsCheck.length > 0) status = "partial";
  // a web quote next to a JD quote is still a claim from the web: only a sentence without one counts as backed
  else if (citesWeb) status = "web_unverified";
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

/**
 * The coach's suggested rewrite of a sentence, checked like any sentence. One without a valid quote is an AI suggestion
 * that has no evidence yet (`ai_suggestion_unverified`) instead of "no evidence": it is advice, not a claim of the answer.
 */
export function verifySuggestion(raw: RawSentence, context: VerifyContext): CheckedSentence {
  const checked = verifySentence(raw, context);
  return checked.status === "unsupported" ? { ...checked, status: "ai_suggestion_unverified" } : checked;
}

export function verifySentences(raw: readonly RawSentence[], context: VerifyContext): CheckedSentence[] {
  return raw.map((sentence) => verifySentence(sentence, context));
}

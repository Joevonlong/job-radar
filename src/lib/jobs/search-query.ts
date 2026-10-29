import { locationSearchTerms } from "./city-aliases";

export interface SearchTerm {
  /** Normalized text of this term, with phrase words separated by spaces. */
  text: string;
  /** The token's text family, or a group of adjacent phrase words. */
  kind: "word" | "phrase" | "symbol" | "cjk";
  /** Whole-word, word-prefix or literal matching for the SQL layer. */
  match: "whole" | "prefix" | "literal";
  /** Ordered phrase words; other terms contain only their own text. */
  words: string[];
  /** All country codes named by this term; empty for ordinary text. */
  countryCodes: string[];
  /** A bare code matches only countries; names also match text fields. */
  countryOnly: boolean;
  /** Normalized city spellings, always starting with this term's text. */
  locationVariants: string[];
}

export interface SearchPlan {
  /** Query-time ranking settings, supplied by the caller rather than loaded by SQL. */
  ranking: SearchRanking;
  /** Empty input, usable terms, or nonempty input without usable terms. */
  status: "none" | "ok" | "no_terms";
  /** Distinct terms retained in query order. */
  terms: SearchTerm[];
  /** Distinct valid terms omitted by the term limit, excluding invalid tokens and duplicates. */
  droppedTerms: number;
  /** At least one retained term contains CJK, including inside phrases. */
  hasCjk: boolean;
  /** All retained words joined by spaces, only when at least two terms remain. */
  phrase: string | null;
}

export interface SearchRanking {
  weights: Readonly<Record<"title" | "company" | "location" | "country" | "description" | "translation", number>>;
  prefixFactor: number;
}

export interface SearchQuerySettings {
  ranking: SearchRanking;
  /** Maximum input length, before normalization. */
  maxChars: number;
  /** Maximum number of distinct terms. */
  maxTerms: number;
  /** Minimum standalone CJK fragment length, in Unicode code points. */
  cjkMinChars: number;
  /** Minimum Latin word length for prefix matching, in Unicode code points. */
  prefixMinChars: number;
}

/** Structural subset of a market country entry; patterns are deliberately unused. */
interface SearchCountry {
  code: string;
  name: string;
  aliases?: readonly string[];
  match?: boolean;
}

interface CountryLexiconOptions {
  locales: readonly string[];
  ambiguousCodes: readonly string[];
  extraAliases: Readonly<Record<string, readonly string[]>>;
}

export interface CountryLexiconEntry {
  /** Uppercase region code. */
  code: string;
  /** A name also matches text; a code is a country-only condition. */
  source: "name" | "code";
}

export interface CountryLexicon {
  /** Normalized word sequence -> every matching country and name/code source. */
  entries: ReadonlyMap<string, readonly CountryLexiconEntry[]>;
  /** Longest recognizable sequence, for greedy country lookup. */
  maxWords: number;
  /** Normalized display names and aliases for all codes, including match:false countries. */
  namesByCode: ReadonlyMap<string, readonly string[]>;
}

interface SearchQueryContext {
  lexicon: CountryLexicon;
  cityAliases: Readonly<Record<string, readonly string[]>>;
  transliterations: Readonly<Record<string, string>>;
  settings: SearchQuerySettings;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const SYMBOL = /[+#.]/u;

/** Shared by query tokens and country names; accents remain significant. */
export function normalizeSearchText(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

/** Punctuation separates tokens except attached plus signs, hashes and dots; Latin and CJK runs separate too. */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const add = (run: string): void => {
    // Keep a single dot prefix (as in .NET); repeated leading dots and sentence dots are punctuation.
    const token = run.replace(/^\.{2,}/u, "").replace(/\.+$/u, "");
    if (LETTER_OR_DIGIT.test(token)) tokens.push(token);
  };
  for (const match of text.matchAll(/[\p{L}\p{N}\p{M}+#.]+/gu)) {
    let run = "";
    let cjk = false;
    for (const char of match[0]) {
      const nextCjk = CJK.test(char);
      if (run !== "" && cjk !== nextCjk && !/\p{M}/u.test(char)) {
        add(run);
        run = "";
      }
      run += char;
      if (!/\p{M}/u.test(char)) cjk = nextCjk;
    }
    add(run);
  }
  return tokens;
}

/** Build name/code lookups once from supplied data, without loading configuration. */
export function buildCountryLexicon(countries: readonly SearchCountry[], options: CountryLexiconOptions): CountryLexicon {
  const entries = new Map<string, CountryLexiconEntry[]>();
  const namesByCode = new Map<string, string[]>();
  const ambiguous = new Set(options.ambiguousCodes);
  let maxWords = 0;
  const add = (words: string[], entry: CountryLexiconEntry): void => {
    if (words.length === 0 || words.some((word) => SYMBOL.test(word))) return;
    const key = words.join(" ");
    const matches = entries.get(key) ?? [];
    if (!matches.some((match) => match.code === entry.code && match.source === entry.source)) matches.push(entry);
    entries.set(key, matches);
    maxWords = Math.max(maxWords, words.length);
  };

  for (const country of countries) {
    const names = new Set([country.name, ...country.aliases ?? [], ...options.extraAliases[country.code] ?? []].map(normalizeSearchText));
    for (const locale of options.locales) {
      try {
        const name = new Intl.DisplayNames([locale], { type: "region" }).of(country.code);
        if (name && name !== country.code) names.add(normalizeSearchText(name));
      } catch {
        // Unsupported locales or region codes contribute no localized name.
      }
    }
    namesByCode.set(country.code, [...names]);
    if (country.match === false) continue;
    for (const name of names) add(tokenize(name), { code: country.code, source: "name" });
    if (!ambiguous.has(country.code)) add([normalizeSearchText(country.code)], { code: country.code, source: "code" });
  }
  return { entries, maxWords, namesByCode };
}

function wordTerm(text: string, settings: SearchQuerySettings): SearchTerm | null {
  const length = [...text].length;
  if (CJK.test(text) && length < settings.cjkMinChars) return null;
  const kind = CJK.test(text) ? "cjk" : SYMBOL.test(text) ? "symbol" : "word";
  return {
    text, kind,
    match: kind === "word" ? (length < settings.prefixMinChars ? "whole" : "prefix") : "literal",
    words: [text], countryCodes: [], countryOnly: false, locationVariants: [],
  };
}

/** Mixed-script phrases retain every run, even a short CJK run, to preserve their exact word sequence. */
function phraseTerm(words: string[]): SearchTerm {
  return { text: words.join(" "), kind: "phrase", match: "whole", words, countryCodes: [], countryOnly: false, locationVariants: [] };
}

/** Longest country name wins; at a given length, names take precedence over bare codes. */
function countryAt(words: string[], start: number, lexicon: CountryLexicon): { words: string[]; countryCodes: string[]; countryOnly: boolean } | null {
  for (let length = Math.min(lexicon.maxWords, words.length - start); length > 0; length -= 1) {
    const candidate = words.slice(start, start + length);
    if (candidate.some((word) => SYMBOL.test(word))) continue;
    const entries = lexicon.entries.get(candidate.join(" "));
    if (!entries) continue;
    const names = entries.filter((entry) => entry.source === "name");
    const matches = names.length > 0 ? names : entries;
    return { words: candidate, countryCodes: [...new Set(matches.map((entry) => entry.code))], countryOnly: names.length === 0 };
  }
  return null;
}

/** Parse supplied text and tables only; safe to use on both server and client. */
export function parseSearchQuery(q: string | null | undefined, context: SearchQueryContext): SearchPlan {
  const empty: SearchPlan = { status: "none", terms: [], droppedTerms: 0, hasCjk: false, phrase: null, ranking: context.settings.ranking };
  if (q == null || q.trim() === "") return empty;
  const text = normalizeSearchText(q.slice(0, context.settings.maxChars));
  const all: SearchTerm[] = [];
  const seen = new Set<string>();
  const add = (term: SearchTerm | null): void => {
    if (term === null) return;
    const key = `${term.kind}:${term.text}`;
    // The first occurrence wins, including its quoted/unquoted interpretation.
    if (seen.has(key)) return;
    seen.add(key);
    all.push(term);
  };

  // Alternating unquoted/quoted spans also handles an unclosed final quote.
  for (const [span, content] of text.split('"').entries()) {
    const words = tokenize(content);
    if (span % 2 === 1) {
      if (words.length > 0) {
        const term = words.length === 1 ? wordTerm(words[0], context.settings) : phraseTerm(words);
        if (term?.kind === "word") term.match = "whole";
        add(term);
      }
      continue;
    }
    for (let index = 0; index < words.length;) {
      const country = countryAt(words, index, context.lexicon);
      const term = country && country.words.length > 1 ? phraseTerm(country.words) : wordTerm(words[index], context.settings);
      if (term && country) {
        term.countryCodes = country.countryCodes;
        term.countryOnly = country.countryOnly;
      }
      add(term);
      index += country?.words.length ?? 1;
    }
  }
  const terms = all.slice(0, context.settings.maxTerms);
  for (const term of terms) term.locationVariants = [...new Set(locationSearchTerms(term.text, context.cityAliases, context.transliterations).map(normalizeSearchText))];
  return {
    ranking: context.settings.ranking,
    status: terms.length > 0 ? "ok" : "no_terms",
    terms,
    droppedTerms: all.length - terms.length,
    hasCjk: terms.some((term) => CJK.test(term.text)),
    phrase: terms.length >= 2 ? terms.flatMap((term) => term.words).join(" ") : null,
  };
}

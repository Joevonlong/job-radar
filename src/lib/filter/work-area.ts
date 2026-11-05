/**
 * Check 2: where may a remote job be done from, in the posting's own words? A phrase counts only when it is explicit and every place
 * it names is in the market's tables. A bare place name, a negated phrase and two statements that disagree are never sure, so a job
 * is hidden only on a clear statement. The phrases are data, in the packs. Pure and free: it runs on every filter pass.
 */
import { lookupPlace, type Place, type PlaceGeo } from "@/lib/market/places";
import { QUOTE_MAX } from "@/lib/signals/quote";

/** `filter.remote.work_area_*`: regex sources. Each of `patterns` has a `(?<place>...)` capture. */
export interface WorkAreaPhrases {
  patterns: readonly string[];
  /** Read in the title only: `France only` in a description is as likely to be about a benefit. */
  titlePatterns: readonly string[];
  anywhere: readonly string[];
  negation: readonly string[];
  connectors: readonly string[];
  /** A next sentence with one of these widens or softens the statement before it. */
  continuations: readonly string[];
  /** What may follow the place. Anything else after it, and the sentence says more than the phrase can read. */
  endings: readonly string[];
  articles: readonly string[];
}

export interface CompiledWorkArea {
  patterns: readonly RegExp[];
  titlePatterns: readonly RegExp[];
  anywhere: readonly RegExp[];
  negation: readonly RegExp[];
  connector: RegExp | null;
  ending: RegExp | null;
  continuation: readonly RegExp[];
  article: RegExp | null;
}

/** What a posting says. `countries` null: anywhere in the world. Not sure: no phrase, a negation, a place the tables do not know, or phrases that disagree. */
export type WorkAreaReading = { sure: true; countries: readonly string[] | null; quote: string } | { sure: false };

const FLAGS = "iu";
const either = (sources: readonly string[]): string | null => (sources.length === 0 ? null : sources.map((source) => `(?:${source})`).join("|"));

export function compileWorkArea(phrases: WorkAreaPhrases): CompiledWorkArea {
  const compile = (sources: readonly string[]): RegExp[] => sources.map((source) => new RegExp(source, FLAGS));
  const connector = either(phrases.connectors);
  const ending = either(phrases.endings);
  const article = either(phrases.articles);
  return {
    patterns: compile(phrases.patterns),
    titlePatterns: compile(phrases.titlePatterns),
    anywhere: compile(phrases.anywhere),
    negation: compile(phrases.negation),
    continuation: compile(phrases.continuations),
    connector: connector === null ? null : new RegExp(connector, FLAGS),
    ending: ending === null ? null : new RegExp(`\\s+(?:${ending})[\\s.,]*$`, FLAGS),
    article: article === null ? null : new RegExp(`^(?:(?:${article})\\s+)+`, FLAGS),
  };
}

/** Sentences of a description, with white space collapsed. A question mark stays on its sentence; a full stop after a lone capital ("U.S.") does not end one; bullets and lines do. */
function sentencesOf(description: string | null): string[] {
  return (description ?? "")
    .split(/(?<=\?)|[!;\n•]+|(?<!\b\p{Lu})\.(?=\s|$)/u)
    .map((piece) => piece.replace(/\s+/g, " ").trim())
    .filter((piece) => piece !== "");
}

/** A place as a posting writes it. A bare ISO code or a short name not in capitals is an ordinary word as often as a place ("hiring in IT", "work with us", "St. Gallen"), so neither counts. */
function writtenPlace(text: string, geo: PlaceGeo): Place | null {
  const place = lookupPlace(text, geo);
  if (place === null) return null;
  if (text.length <= 3 && text !== text.toUpperCase()) return null;
  if (place.kind !== "country" || place.token === null) return place;
  return geo.countries.some((country) => country.aliases.includes(text)) ? place : null;
}

/**
 * The countries a captured list names. Null when any part cannot be placed: a part read wrongly could hide a job. A city is one of those, because
 * the same name may be a town at home, and the table only has one of them. An empty list means anywhere.
 */
function countriesOfList(capture: string, area: CompiledWorkArea, geo: PlaceGeo): readonly string[] | null {
  const list = area.ending === null ? capture : capture.replace(area.ending, "");
  const tokens = (area.connector === null ? [list] : list.split(area.connector)).map((token) => (area.article === null ? token : token.trim().replace(area.article, "")).trim().replace(/(?<!\b\p{Lu})[\s.,]+$/u, "").replace(/[\s,]+$/, ""));
  const countries: string[] = [];
  for (const token of tokens) {
    const place = writtenPlace(token, geo);
    if (place === null) return null;
    if (place.kind === "worldwide") return [];
    if (place.kind === "city" || place.countries.length === 0) return null;
    countries.push(...place.countries);
  }
  return countries.length === 0 ? null : [...new Set(countries)].sort();
}

/** A sentence that opens with a connector or a place, or says the area is wider, may carry on the statement before it. */
function carriesOn(sentence: string | undefined, area: CompiledWorkArea, geo: PlaceGeo): boolean {
  if (sentence === undefined) return false;
  if (area.continuation.some((pattern) => pattern.test(sentence))) return true;
  const unmarked = ` ${sentence.replace(/^[^\p{L}]+/u, "")}`;
  const joined = area.connector?.exec(unmarked) ?? null;
  if (joined?.index === 0) return true;
  const rest = unmarked.trim();
  const [first = "", second = ""] = (area.article === null ? rest : rest.replace(area.article, "")).split(" ");
  const bare = (text: string): string => text.replace(/[^\p{L}\p{N}]+$/u, "");
  return writtenPlace(bare(`${first} ${second}`), geo) !== null || writtenPlace(bare(first), geo) !== null || writtenPlace(first.split("-")[0] ?? "", geo) !== null;
}

const sameArea = (a: readonly string[] | null, b: readonly string[] | null): boolean => (a === null || b === null ? a === b : a.length === b.length && a.every((country, index) => country === b[index]));
function bareQuote(text: string): string {
  const quote = text.slice(text.search(/[\p{L}\p{N}]/u)).replace(/[^\p{L}\p{N}]{1,8}$/u, "");
  return quote.length > QUOTE_MAX ? `${quote.slice(0, QUOTE_MAX - 1)}…` : quote;
}

type Statement = { countries: readonly string[] | null; quote: string };

/** What follows a phrase's match is more than a full stop, or the match ends in a question: the sentence says something the phrase cannot read. */
function saysMore(sentence: string, match: RegExpExecArray, area: CompiledWorkArea): boolean {
  if (sentence.endsWith("?")) return true;
  const tail = sentence.slice(match.index + match[0].length);
  return tail !== "" && !/^[\s.,!)]*$/.test(tail) && (area.ending === null || ` ${tail}`.replace(area.ending, "").trim() !== "");
}

/** What one sentence states. Null: it is not sure, and neither is the posting. */
function statementsOf(sentence: string, patterns: readonly RegExp[], next: string | undefined, area: CompiledWorkArea, geo: PlaceGeo): Statement[] | null {
  const statements: Statement[] = [];
  let unplaced = false;
  for (const pattern of sentence.endsWith("?") ? [] : area.anywhere) {
    const match = pattern.exec(sentence);
    if (match !== null) statements.push({ countries: null, quote: bareQuote(match[0]) });
  }
  for (const pattern of patterns) {
    const match = pattern.exec(sentence);
    if (match === null) continue;
    const countries = countriesOfList(match.groups?.place ?? "", area, geo);
    if (countries === null || saysMore(sentence, match, area) || carriesOn(next, area, geo)) unplaced = true;
    else statements.push({ countries: countries.length === 0 ? null : countries, quote: bareQuote(match[0]) });
  }
  if (statements.length === 0 && !unplaced) return [];
  return unplaced || area.negation.some((pattern) => pattern.test(sentence)) ? null : statements;
}

/** Read one posting's title and description. */
export function readWorkArea(title: string, description: string | null, area: CompiledWorkArea, geo: PlaceGeo): WorkAreaReading {
  const inTitle = statementsOf(title.replace(/\s+/g, " ").trim(), [...area.titlePatterns, ...area.patterns], undefined, area, geo);
  if (inTitle === null) return { sure: false };
  const found = [...inTitle];
  const sentences = sentencesOf(description);
  for (const [index, sentence] of sentences.entries()) {
    const statements = statementsOf(sentence, area.patterns, sentences[index + 1], area, geo);
    if (statements === null) return { sure: false };
    found.push(...statements);
  }
  const first = found[0];
  if (first === undefined || found.some((other) => !sameArea(other.countries, first.countries))) return { sure: false };
  return { sure: true, countries: first.countries, quote: first.quote };
}

const escaped = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wholeWords = (words: readonly string[], flags: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(escaped).join("|")})(?![\\p{L}\\p{N}])`, flags);

/** The names of the places a posting may require, as whole-word patterns. A short name counts only in capitals ("UK", not "us"). A posting that hides on another country but names one of these elsewhere is a mixed signal. */
export function compileLivePlaces(spellings: readonly string[]): readonly RegExp[] {
  const words = [...new Set(spellings.map((spelling) => spelling.trim().replace(/\s+/g, " ")).filter((spelling) => spelling !== ""))];
  const long = words.filter((word) => word.length > 3);
  const short = words.filter((word) => word.length <= 3 && word === word.toUpperCase());
  return [...(long.length > 0 ? [wholeWords(long, FLAGS)] : []), ...(short.length > 0 ? [wholeWords(short, "u")] : [])];
}

/** The text names one of the places. */
export function namesLivePlace(title: string, description: string | null, livePlaces: readonly RegExp[]): boolean {
  const text = `${title}\n${description ?? ""}`.replace(/\s+/g, " ");
  return livePlaces.some((pattern) => pattern.test(text));
}

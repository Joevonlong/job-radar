import type { PipelineConfig } from "@/lib/config";
import type { JobLocation } from "@/lib/domain/types";
import type { Market } from "@/lib/market/types";

import { slugify } from "./geography";
import { GENDER_MARKER, normalizeTitle } from "./normalize";
import { hammingDistance } from "./simhash";

/**
 * How a posting's title relates to a job's, for the SimHash pass of `decideMatch` (a shared JD says little when a company
 * reuses it for other levels and directions). Pure: no database, shared by production and the offline replay.
 *
 * - `same`: the stored title keys (`normalizeTitle`) are equal;
 * - `compatible`: the titles differ only by what `titleCore` strips (city, a country both sides are in, work mode, gender
 *   marker), by spelling (`synonyms`) or by word order;
 * - `different`: anything else. A difference this code does not recognise never counts as the same job.
 */
export type TitleRelation = "same" | "compatible" | "different";

type DedupeConfig = PipelineConfig["dedupe"];
type TitleGuardConfig = DedupeConfig["title_guard"];

export interface CompiledTitleGuard {
  ignorePatterns: readonly RegExp[];
  synonyms: ReadonlyMap<string, readonly string[]>;
  connectors: ReadonlySet<string>;
  workModes: ReadonlySet<string>;
  seniority: ReadonlySet<string>;
  scope: ReadonlySet<string>;
  cities: Market["cities"];
  /** Name or alias (segment key) -> country code, for the countries the market's table matches. */
  countries: ReadonlyMap<string, string>;
}

/** The side of a comparison: what a title is read against. */
export interface TitleSide {
  title: string;
  titleNorm: string;
  locations: readonly JobLocation[];
}

/**
 * What segments and words are compared by: lower case, single spaces, no punctuation at either end ("Sr." -> "sr"). Always
 * the whole segment or word: "Internal" is never `intern`.
 */
function segmentKey(text: string): string {
  return text
    .toLocaleLowerCase("en")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.,:;!?"'“”‘’„«»]+|[.,:;!?"'“”‘’„«»]+$/gu, "")
    .trim();
}

const compiledCache = new WeakMap<TitleGuardConfig, WeakMap<Market, CompiledTitleGuard>>();

/** The guard's lists and the market's tables, compiled once per config and market object. */
export function compileTitleGuard(guard: TitleGuardConfig, market: Market): CompiledTitleGuard {
  let perMarket = compiledCache.get(guard);
  if (!perMarket) {
    perMarket = new WeakMap();
    compiledCache.set(guard, perMarket);
  }
  const hit = perMarket.get(market);
  if (hit) return hit;
  const countries = new Map<string, string>();
  for (const country of market.countries) {
    if (!country.match) continue;
    for (const name of [country.name, ...country.aliases]) {
      const key = segmentKey(name);
      if (!countries.has(key)) countries.set(key, country.code);
    }
  }
  const compiled: CompiledTitleGuard = {
    ignorePatterns: guard.ignore_patterns.map((pattern) => new RegExp(pattern, "giu")),
    synonyms: new Map(Object.entries(guard.synonyms).map(([from, to]) => [normalizeTitle(from), normalizeTitle(to).split(" ")])),
    connectors: new Set(guard.city_connectors.map(segmentKey)),
    workModes: new Set(guard.work_mode_words.map(segmentKey)),
    seniority: new Set(guard.seniority_words.map(segmentKey)),
    scope: new Set(guard.scope_words.map(segmentKey)),
    cities: market.cities,
    countries,
  };
  perMarket.set(market, compiled);
  return compiled;
}

interface ReadContext {
  compiled: CompiledTitleGuard;
  /** Slugs of the cities in either side's locations. */
  locationCities: ReadonlySet<string>;
  /** Countries both sides have a location in. */
  sharedCountries: ReadonlySet<string>;
  /** Filled with the country of every country segment met while peeling, stripped or not. */
  countrySegments: Set<string>;
}

function isCity(text: string, ctx: ReadContext): boolean {
  const key = segmentKey(text);
  if (key === "") return false;
  if (Object.hasOwn(ctx.compiled.cities, key)) return true;
  const slug = slugify(key);
  return slug !== "" && ctx.locationCities.has(slug);
}

/** "in Berlin": a connector word, then all the rest a city. */
function isConnectorCity(text: string, ctx: ReadContext): boolean {
  const words = text.trim().split(/\s+/);
  return words.length >= 2 && ctx.compiled.connectors.has(segmentKey(words[0] ?? "")) && isCity(words.slice(1).join(" "), ctx);
}

/** Whether a whole segment says nothing about which job it is. A protected scope word always counts: it is kept. */
function isIgnorable(text: string, ctx: ReadContext): boolean {
  const key = segmentKey(text);
  if (key === "") return true;
  if (ctx.compiled.scope.has(key)) return false;
  const country = ctx.compiled.countries.get(key);
  if (country !== undefined) ctx.countrySegments.add(country);
  if (isCity(text, ctx) || isConnectorCity(text, ctx)) return true;
  if (country !== undefined && ctx.sharedCountries.has(country)) return true;
  return ctx.compiled.workModes.has(key);
}

const isOpen = (char: string): boolean => char === "(" || char === "[";
const isClose = (char: string): boolean => char === ")" || char === "]";
const EDGE_SEPARATORS = /^[\s\-–—|,/·]+|[\s\-–—|,/·]+$/gu;

/** Offsets of the separators outside any brackets: " - ", " – ", "|", ",", "/", "·". */
function topLevelSeparators(text: string): number[] {
  const found: number[] = [];
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    if (isOpen(char)) depth += 1;
    else if (isClose(char)) depth = Math.max(0, depth - 1);
    else if (depth > 0) continue;
    else if ("|,/·".includes(char)) found.push(i);
    else if ((char === "-" || char === "–" || char === "—") && /\s/.test(text[i - 1] ?? "") && /\s/.test(text[i + 1] ?? "")) found.push(i);
  }
  return found;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const at of topLevelSeparators(text)) {
    parts.push(text.slice(start, at));
    start = at + 1;
  }
  parts.push(text.slice(start));
  return parts;
}

function allIgnorable(content: string, ctx: ReadContext): boolean {
  // every part is read, so that a country segment is noted even after a part that is not ignorable
  return splitTopLevel(content)
    .map((part) => isIgnorable(part, ctx))
    .every(Boolean);
}

/** What is left when the last segment goes, or null when it stays. */
function peelEnd(text: string, ctx: ReadContext): string | null {
  const at = topLevelSeparators(text).at(-1);
  if (isClose(text.at(-1) ?? "")) {
    let depth = 0;
    for (let i = text.length - 1; i >= 0; i -= 1) {
      const char = text[i] as string;
      if (isClose(char)) depth += 1;
      else if (isOpen(char)) depth -= 1;
      if (depth === 0) {
        if (allIgnorable(text.slice(i + 1, -1), ctx)) return text.slice(0, i);
        break;
      }
    }
    // the brackets may be part of the segment's own name: "... - Frankfurt (Main)"
    return at !== undefined && isCity(text.slice(at + 1), ctx) ? text.slice(0, at) : null;
  }
  if (at === undefined) return null;
  return isIgnorable(text.slice(at + 1), ctx) ? text.slice(0, at) : null;
}

/** What is left when the first segment goes, or null when it stays. */
function peelStart(text: string, ctx: ReadContext): string | null {
  if (isOpen(text[0] ?? "")) {
    let depth = 0;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i] as string;
      if (isOpen(char)) depth += 1;
      else if (isClose(char)) depth -= 1;
      if (depth === 0) return allIgnorable(text.slice(1, i), ctx) ? text.slice(i + 1) : null;
    }
    return null;
  }
  const at = topLevelSeparators(text)[0];
  if (at === undefined) return null;
  return isIgnorable(text.slice(0, at), ctx) ? text.slice(at + 1) : null;
}

/** The title without a trailing "in Nürnberg" (a connector, then a city up to the end), or null. */
function peelConnectorCity(text: string, ctx: ReadContext): string | null {
  const start = (topLevelSeparators(text).at(-1) ?? -1) + 1;
  const words = [...text.slice(start).matchAll(/\S+/g)];
  for (let i = 0; i < words.length - 1; i += 1) {
    const word = words[i] as RegExpExecArray;
    if (!ctx.compiled.connectors.has(segmentKey(word[0]))) continue;
    const rest = words.slice(i + 1).map((w) => w[0]).join(" ");
    if (!ctx.compiled.scope.has(segmentKey(rest)) && isCity(rest, ctx)) return text.slice(0, start + word.index);
  }
  return null;
}

/** The title without a first word that is a work mode, when a seniority word follows ("Remote Senior Engineer"), or null. */
function peelLeadingWorkMode(text: string, ctx: ReadContext): string | null {
  const match = /^(\S+)\s+(\S+)/u.exec(text);
  if (!match) return null;
  if (!ctx.compiled.workModes.has(segmentKey(match[1] as string)) || !ctx.compiled.seniority.has(segmentKey(match[2] as string))) return null;
  return text.slice((match[1] as string).length);
}

const hasWords = (text: string): boolean => normalizeTitle(text) !== "";

export interface TitleCore {
  /** Words of the core, sorted and joined. */
  core: string;
  /** Countries of the country segments the title carries at its ends, stripped or not. */
  countries: ReadonlySet<string>;
}

/**
 * The title without what does not tell jobs apart. `rawTitle` is the cleaned title (`cleanTitle`), `own` and `other` the
 * locations of the two sides: cities are looked up in both, countries must be shared by both.
 */
export function titleCore(rawTitle: string, sides: { own: readonly JobLocation[]; other: readonly JobLocation[] }, compiled: CompiledTitleGuard): TitleCore {
  // the supplements first: GENDER_MARKER would eat half of "(m/w/div)" and leave "/div)" for them
  let text = rawTitle;
  for (const pattern of compiled.ignorePatterns) text = text.replace(pattern, " ");
  text = text.replace(GENDER_MARKER, " ").trim();

  const countriesOf = (locations: readonly JobLocation[]): Set<string> => new Set(locations.flatMap((l) => (l.countryCode ? [l.countryCode] : [])));
  const otherCountries = countriesOf(sides.other);
  const ctx: ReadContext = {
    compiled,
    locationCities: new Set([...sides.own, ...sides.other].flatMap((l) => (l.city ? [slugify(l.city)] : []))),
    sharedCountries: new Set([...countriesOf(sides.own)].filter((code) => otherCountries.has(code))),
    countrySegments: new Set(),
  };

  // a step that would leave no words is not taken ("Berlin" stays "Berlin")
  const steps = [peelEnd, peelStart, peelConnectorCity, peelLeadingWorkMode];
  for (let changed = true; changed; ) {
    changed = false;
    const tidy = text.replace(EDGE_SEPARATORS, "");
    if (tidy !== text && hasWords(tidy)) {
      text = tidy;
      changed = true;
    }
    for (const step of steps) {
      const next = step(text, ctx);
      if (next === null || !hasWords(next)) continue;
      text = next.trim();
      changed = true;
    }
  }

  const words = normalizeTitle(text)
    .split(" ")
    .flatMap((word) => compiled.synonyms.get(word) ?? [word]);
  return { core: words.sort().join(" "), countries: ctx.countrySegments };
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((value) => b.has(value));

export function classifyTitles(incoming: TitleSide, candidate: TitleSide, compiled: CompiledTitleGuard): TitleRelation {
  // an empty key says nothing about the job (it never makes an exact key either): only the cores can relate such titles
  if (incoming.titleNorm !== "" && incoming.titleNorm === candidate.titleNorm) return "same";
  const left = titleCore(incoming.title, { own: incoming.locations, other: candidate.locations }, compiled);
  const right = titleCore(candidate.title, { own: candidate.locations, other: incoming.locations }, compiled);
  if (left.countries.size > 0 && right.countries.size > 0 && !sameSet(left.countries, right.countries)) return "different";
  return left.core === right.core ? "compatible" : "different";
}

/** The SimHash distance a relation may merge at; null: never on the description alone. */
export function limitFor(relation: TitleRelation, dedupe: DedupeConfig): number | null {
  if (relation === "same") return dedupe.title_guard.same_title_max_distance;
  if (relation === "compatible") return dedupe.simhash_max_distance;
  return dedupe.title_guard.different_title_max_distance;
}

export interface SimhashCandidate extends TitleSide {
  id: number;
  simhash: string | null;
}

export interface SimhashSelection<C extends SimhashCandidate> {
  selected: { candidate: C; relation: TitleRelation | null; distance: number; limit: number } | null;
  /** Nothing was selected, and a candidate the old rule would have merged has a different title. */
  blocked: boolean;
}

/**
 * The SimHash pass over the same company's jobs (`candidates` in id order). With the guard on, each candidate is held to the
 * limit of its relation and the nearest wins, then the lowest id. With it off, the first within `simhash_max_distance` wins,
 * whatever its title.
 */
export function selectSimhashCandidate<C extends SimhashCandidate>(incoming: TitleSide & { simhash: string }, candidates: readonly C[], dedupe: DedupeConfig, compiled: CompiledTitleGuard): SimhashSelection<C> {
  if (!dedupe.title_guard.enabled) {
    for (const candidate of candidates) {
      if (candidate.simhash === null) continue;
      const distance = hammingDistance(incoming.simhash, candidate.simhash);
      if (distance <= dedupe.simhash_max_distance) return { selected: { candidate, relation: null, distance, limit: dedupe.simhash_max_distance }, blocked: false };
    }
    return { selected: null, blocked: false };
  }
  const { same_title_max_distance: sameMax, different_title_max_distance: differentMax } = dedupe.title_guard;
  const reach = Math.max(sameMax, dedupe.simhash_max_distance, differentMax ?? 0);
  let selected: SimhashSelection<C>["selected"] = null;
  let blocked = false;
  for (const candidate of candidates) {
    if (candidate.simhash === null) continue;
    const distance = hammingDistance(incoming.simhash, candidate.simhash);
    if (distance > reach) continue;
    const relation = classifyTitles(incoming, candidate, compiled);
    const limit = limitFor(relation, dedupe);
    if (limit !== null && distance <= limit) {
      if (selected === null || distance < selected.distance || (distance === selected.distance && candidate.id < selected.candidate.id)) selected = { candidate, relation, distance, limit };
    } else if (relation === "different" && distance <= dedupe.simhash_max_distance) {
      blocked = true;
    }
  }
  return { selected, blocked: selected === null && blocked };
}

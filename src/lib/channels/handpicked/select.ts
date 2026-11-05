import { foldText } from "@/lib/filter/text";
import { citySpellings, lookupPlace, placeAreas, wantedLocations, type PlaceGeo, type PlacePreferences } from "@/lib/market/places";

import type { TitlePrefilter } from "../ats/prefilter";
import { boardFromUrl, boardKey } from "../discovery/boards";
import type { BoardLink } from "../discovery/harvest";
import { fromDateOnly } from "./parse";
import type { HandpickedIndexEntry } from "./schema";

/**
 * Which index entries the channel keeps. Pure functions of the entries and the user's configuration: the places come from
 * the home city and places of preferences.yaml (with every spelling the tables know), never from the code.
 */

export interface Places {
  /** Folded names of the wanted cities, their aliases included. */
  cities: ReadonlySet<string>;
  /** Countries where any city counts: those I'd move to, and home without a home city. */
  wholeCountries: ReadonlySet<string>;
  /** The countries the tables give a city's slug. */
  countriesOf: (slug: string) => readonly string[];
  /** `workplace` has remote. */
  remote: boolean;
  /** Countries a remote posting may be open to: home and the listed ones (upper case). Null: any (Worldwide is listed). */
  countries: ReadonlySet<string> | null;
}

export function buildPlaces(input: { preferences: PlacePreferences & { workplace: readonly string[] }; geo: PlaceGeo; country: string }): Places {
  const cities = new Set<string>();
  for (const location of wantedLocations(input.preferences)) for (const name of citySpellings(location, input.geo)) cities.add(foldText(name));
  const areas = placeAreas(input.preferences, input.geo, input.country.toUpperCase());
  const wholeCountries = new Set([...areas.moveCountries, ...(areas.anywhereInHome ? [input.country.toUpperCase()] : [])]);
  const countriesOf = (slug: string): readonly string[] => lookupPlace(slug, input.geo)?.countries ?? [];
  return { cities, wholeCountries, countriesOf, remote: input.preferences.workplace.includes("remote"), countries: areas.worldwide ? null : areas.remoteCountries };
}

/** A wanted place by `cities`, or a remote posting open to home or a listed country (an empty country list means "not restricted"). */
export function matchesPlace(entry: Pick<HandpickedIndexEntry, "cities" | "remoteType" | "remoteCountryCodes">, places: Places): boolean {
  if (entry.cities.some((slug) => places.cities.has(foldText(slug)) || places.countriesOf(slug).some((country) => places.wholeCountries.has(country)))) return true;
  if (entry.remoteType !== "remote" || !places.remote) return false;
  const { countries } = places;
  return countries === null || entry.remoteCountryCodes.length === 0 || entry.remoteCountryCodes.some((code) => countries.has(code.toUpperCase()));
}

export interface SelectOptions {
  places: Places;
  maxAgeDays: number;
  now: Date;
  prefilter: TitlePrefilter;
  /** `boardKey`s of `ats_boards`. */
  known: ReadonlySet<string>;
  skipKnownBoards: boolean;
}

export interface SelectStats {
  listed: number;
  /** Dropped per step, in the order the steps run. */
  place: number;
  tooOld: number;
  prefiltered: number;
  knownBoard: number;
  kept: number;
}

export interface Selected {
  entry: HandpickedIndexEntry;
  postedAt: Date;
}

/** Place -> age -> title prefilter -> boards the ATS channels already read. Newest first. */
export function selectPostings(entries: readonly HandpickedIndexEntry[], options: SelectOptions): { selected: Selected[]; stats: SelectStats } {
  const stats: SelectStats = { listed: entries.length, place: 0, tooOld: 0, prefiltered: 0, knownBoard: 0, kept: 0 };
  const today = Date.UTC(options.now.getUTCFullYear(), options.now.getUTCMonth(), options.now.getUTCDate());
  const cutoff = today - options.maxAgeDays * 86_400_000;
  const selected: Selected[] = [];
  for (const entry of entries) {
    if (!matchesPlace(entry, options.places)) {
      stats.place += 1;
      continue;
    }
    const postedAt = fromDateOnly(entry.postedAt);
    if (postedAt === null || postedAt.getTime() < cutoff) {
      stats.tooOld += 1;
      continue;
    }
    if (!options.prefilter.decide(entry.title, entry.company).keep) {
      stats.prefiltered += 1;
      continue;
    }
    if (options.skipKnownBoards) {
      const board = boardFromUrl(entry.url);
      if (board && options.known.has(boardKey(board.ats, board.token))) {
        stats.knownBoard += 1;
        continue;
      }
    }
    selected.push({ entry, postedAt });
  }
  selected.sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());
  stats.kept = selected.length;
  return { selected, stats };
}

/** The links company discovery looks at: postings of the wanted places, by title too unless `requireTitleMatch` is off. Age does not matter. */
export function discoveryLinks(entries: readonly HandpickedIndexEntry[], options: { places: Places; prefilter: TitlePrefilter; requireTitleMatch: boolean }): BoardLink[] {
  return entries
    .filter((entry) => matchesPlace(entry, options.places) && (!options.requireTitleMatch || options.prefilter.decide(entry.title, entry.company).keep))
    .map((entry) => ({ url: entry.url, label: entry.company.trim() || null }));
}

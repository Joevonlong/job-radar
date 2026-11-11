import type { PipelineConfig, PreferencesConfig } from "@/lib/config";
import type { GermanLevel, JobLocation, JobSalary } from "@/lib/domain/types";
import { canonicalCity, citySpellings, lookupPlace, placeAreas, placeGeo, type PlaceGeo } from "@/lib/market/places";
import type { Market } from "@/lib/market/types";
import { buildBlacklistedCompanyKeys, buildWatchedCompanyKeys, isCompanyExcluded, isCompanyWatched } from "@/lib/companies/marks";
import { visaRulesFor } from "@/lib/visa/rules";

import { compileDealBreakers, type CompiledDealBreakers, type DealBreakerMe, type TimeBox } from "./deal-breakers";
import { encodeReason } from "./reasons";
import { salaryBelowFloor } from "./salary";
import { foldText, foldTransliterated } from "./text";
import { compileLivePlaces, compileWorkArea, namesLivePlace, readWorkArea, type CompiledWorkArea, type WorkAreaReading } from "./work-area";

export { foldText, foldTransliterated } from "./text";

/**
 * The hard filter: pure rules over the fields the pipeline already normalized
 * (contract, salary per year in the base currency, locations, workplace, seniority), plus the user's own words and rules
 * (`exclude_keywords`, `deal_breakers`). Nothing here parses a job description for facts. What a posting does not state
 * never excludes it: the job is kept and, where it matters, noted.
 */

export interface FilterJob {
  title: string;
  description: string | null;
  companyName: string;
  /** `companies.name_norm` (a visa deal-breaker reads it). */
  companyNameNorm?: string | null;
  /** Other spellings of the company (`companies.aliases`). */
  companyAliases: readonly string[];
  /** `companies.blacklisted`. */
  companyBlacklisted: boolean;
  /** `companies.watched`: the user watches the company by the database flag (the watch list is `FilterContext.watchedCompanies`). */
  companyWatched: boolean;
  locations: readonly JobLocation[];
  workplace: "onsite" | "hybrid" | "remote" | "unknown";
  seniority: string;
  contract: string;
  salary: JobSalary | null;
  /** `jobs.german_level_required`: the pipeline's rule reading of the local language (what a language gate reads). */
  germanLevel: GermanLevel;
}

export type FilterResult = "passed" | "filtered_out";

export interface FilterVerdict {
  result: FilterResult;
  /** Reason codes (see reasons.ts). `filtered_out`: why; `passed`: notes about what the posting leaves open. */
  reasons: string[];
}

const escapePattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A word or phrase that must stand alone: not inside a longer word ("Rust" does not hit "trust"). */
export function wholeWordPattern(term: string): RegExp {
  return new RegExp(wholeWordSource([term], false), "iu");
}

/** Base letter (a-z) -> the Latin letters with diacritics that fold to it ("u" -> "ùúûüũūŭůűų…"). Built once. */
let accentVariants: Map<string, string> | null = null;
function variantsOf(base: string): string {
  if (accentVariants === null) {
    const table = new Map<string, string>();
    for (const [from, to] of [
      [0xc0, 0x24f],
      [0x1e00, 0x1eff],
    ] as const) {
      for (let cp = from; cp <= to; cp += 1) {
        const char = String.fromCodePoint(cp);
        const folded = char.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
        if (/^[a-z]$/u.test(folded) && folded !== char.toLowerCase()) table.set(folded, (table.get(folded) ?? "") + char);
      }
    }
    accentVariants = table;
  }
  return accentVariants.get(base) ?? "";
}

/** One term as a pattern body that ignores accents ("Munchen" hits "München", "Strasse" hits "Straße"). Case is left to the `i` flag. */
function accentFoldedBody(term: string): string {
  const folded = term.normalize("NFD").replace(/\p{M}/gu, "").replace(/ß/gu, "ss").toLowerCase();
  let out = "";
  for (let i = 0; i < folded.length; i += 1) {
    const char = folded.charAt(i);
    if (char === "s" && folded.charAt(i + 1) === "s") {
      out += "(?:ss|ß)";
      i += 1;
    } else if (/\s/u.test(char)) {
      while (/\s/u.test(folded.charAt(i + 1))) i += 1;
      out += "\\s+";
    } else {
      const variants = /^[a-z]$/u.test(char) ? variantsOf(char) : "";
      out += variants === "" ? escapePattern(char) : `[${char}${variants}]`;
    }
  }
  return out;
}

/** Source of a pattern matching any of `terms` as a whole word or phrase; `foldAccents` makes the letters accent-insensitive. */
export function wholeWordSource(terms: readonly string[], foldAccents: boolean): string {
  const bodies = terms.map((term) => (foldAccents ? accentFoldedBody(term.trim()) : term.trim().split(/\s+/).map(escapePattern).join("\\s+")));
  const body = bodies.length === 1 ? (bodies[0] ?? "") : `(?:${bodies.join("|")})`;
  return `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`;
}

/** A city or an unknown name from the location settings, ready to compare locations with. */
interface NamedTarget {
  /** Folded names: its spellings and the towns of its metro area. */
  names: ReadonlySet<string>;
  patterns: readonly RegExp[];
  /** Folded names of regions that contain it but are too coarse to say ("Bavaria"). */
  regions: ReadonlySet<string>;
  /** The countries it lies in; null: its text counts in any country. */
  countries: ReadonlySet<string> | null;
  /** The home city or a place I'd move to: on-site and hybrid jobs count here. */
  relocate: boolean;
}

export interface CompiledFilter {
  preferences: PreferencesConfig;
  /** The home city first, then the listed cities and unknown names. */
  named: readonly NamedTarget[];
  /** No home city: a location that states the home country counts. */
  anywhereInHome: boolean;
  /** Countries I'd move to: any location there counts. */
  moveCountries: ReadonlySet<string>;
  /** Texts that name only a country ("Germany"). */
  countryLevel: readonly RegExp[];
  /** Folded names of the countries that hold a city I'd move to, the home country aside: such a text may still be that city. */
  cityCountryNames: ReadonlySet<string>;
  countryLevelOnsitePolicy: "keep_note" | "exclude";
  genericLocation: readonly RegExp[];
  /** The market's home country. */
  homeCountry: string;
  /** The market's base currency: what the salary floor is in. */
  baseCurrency: string;
  /** Where a remote job may be based: the home country and the listed countries and regions; null = all (Worldwide is listed). */
  scopeCountries: ReadonlySet<string> | null;
  /** Names of the countries of `scopeCountries`; a short one only as written, in capitals, because "us" is also a word. */
  scopeNames: readonly RegExp[];
  /** Location texts that name a wide area covering home or a listed place ("EU", "Europe"). */
  scopeWide: readonly RegExp[];
  worldwide: readonly RegExp[];
  outside: readonly RegExp[];
  /** Region markers of a remote posting's title that say it hires outside the scope ("- US", "US East Coast"). */
  titleOutside: readonly RegExp[];
  /** `, NY` / `- TX` after a place: a state of a country outside the scope. Case-sensitive. */
  outsideStateCode: RegExp | null;
  /** Description phrases saying the posting hires in the home country / region. */
  descriptionInScope: readonly RegExp[];
  /** The phrases of check 2, the tables they are read with, and the countries a posting may require. */
  workArea: CompiledWorkArea;
  geo: PlaceGeo;
  liveCountries: ReadonlySet<string>;
  liveOpen: boolean;
  livePlaces: readonly RegExp[];
  seniorities: readonly string[] | null;
  blacklistedCompanyKeys: ReadonlySet<string>;
  /** Resolved keys of `interests.yaml: watched_companies` (the push step's keys). */
  watchedCompanyKeys: ReadonlySet<string>;
  keywords: ReadonlyArray<{ keyword: string; pattern: RegExp }>;
  legalSuffixes: readonly string[];
  /** preferences.yaml `deal_breakers`, compiled. */
  dealBreakers: CompiledDealBreakers;
  pipeline: PipelineConfig;
}

/** What the filter reads besides preferences.yaml and pipeline.yaml. */
export interface FilterContext {
  /** me.yaml (the user's languages, for a language gate); null = it cannot be read: such a gate does nothing. */
  me: DealBreakerMe | null;
  /** `interests.yaml: watched_companies` (company names): a watched company's on-site jobs are kept anywhere in the home country. Default: none. */
  watchedCompanies?: readonly string[];
}

const compilePatterns = (patterns: readonly string[]): RegExp[] => patterns.map((p) => new RegExp(p, "iu"));

/** Preferences + pipeline.yaml (+ me.yaml for a language gate) prepared for evaluating many jobs. */
export function compileFilter(preferences: PreferencesConfig, pipeline: PipelineConfig, context: FilterContext = { me: null }): CompiledFilter {
  const cfg = pipeline.filter;
  const market: Market = pipeline.market;
  const transliterations = market.transliterations;

  const geo = placeGeo(pipeline);
  const areas = placeAreas(preferences, geo, market.country);
  const spellings = (name: string): string[] => citySpellings(name, geo);

  const metroOf = new Map<string, string[]>();
  for (const [city, towns] of Object.entries(cfg.metro_areas)) {
    const key = foldText(canonicalCity(city, geo));
    metroOf.set(key, [...(metroOf.get(key) ?? []), ...towns]);
  }
  const regionsOf = new Map<string, string[]>();
  for (const [city, regions] of Object.entries(cfg.metro_regions)) {
    const key = foldText(canonicalCity(city, geo));
    regionsOf.set(key, [...(regionsOf.get(key) ?? []), ...regions]);
  }

  const named = areas.named.map((place): NamedTarget => {
    const canonical = canonicalCity(place.text, geo);
    const names = new Set<string>();
    const add = (name: string): void => {
      names.add(foldText(name));
      names.add(foldTransliterated(name, transliterations));
    };
    for (const name of spellings(place.text)) add(name);
    for (const town of metroOf.get(foldText(canonical)) ?? []) for (const name of spellings(town)) add(name);
    return {
      names,
      patterns: [...names].map((name) => wholeWordPattern(name)),
      regions: new Set((regionsOf.get(foldText(canonical)) ?? []).map((region) => foldText(region))),
      countries: place.countries === null ? null : new Set(place.countries),
      relocate: place.relocate,
    };
  });
  const cityCountries = new Set(areas.named.flatMap((place) => (place.relocate ? (place.countries ?? []) : [])).filter((country) => country !== market.country));
  const cityCountryNames = new Set(market.countries.filter((country) => cityCountries.has(country.code)).flatMap((country) => [country.name, ...country.aliases]).map((name) => foldText(name)));
  const remoteCountries = areas.worldwide ? null : areas.remoteCountries;
  const scopeNames = market.countries.filter((country) => remoteCountries?.has(country.code)).flatMap((country) => [country.name, ...country.aliases]).map((name) => (name.length <= 3 ? new RegExp(wholeWordSource([name], false), "u") : wholeWordPattern(foldText(name))));
  const wideRegions = [...new Set([...(market.homeRegion === null ? [] : [market.homeRegion]), ...areas.wideRegions])];

  const blacklistedCompanyKeys = buildBlacklistedCompanyKeys(preferences.exclude_companies, pipeline);

  const seniorities = preferences.seniority === "all" ? null : cfg.seniority_map[preferences.seniority];

  return {
    preferences,
    named,
    anywhereInHome: areas.anywhereInHome,
    moveCountries: areas.moveCountries,
    countryLevel: compilePatterns(cfg.country_level.patterns),
    cityCountryNames,
    countryLevelOnsitePolicy: cfg.country_level.onsite_policy,
    genericLocation: compilePatterns(cfg.generic_location_patterns),
    homeCountry: market.country,
    baseCurrency: market.currency,
    scopeCountries: remoteCountries,
    scopeNames,
    scopeWide: compilePatterns(areas.worldwide ? [] : wideRegions.flatMap((token) => market.regions[token]?.patterns ?? [])),
    worldwide: compilePatterns(cfg.remote.worldwide_patterns),
    outside: compilePatterns(cfg.remote.outside_patterns),
    titleOutside: compilePatterns(cfg.remote.title_outside_patterns),
    outsideStateCode: outsideStateCodes(market, remoteCountries),
    descriptionInScope: compilePatterns(cfg.remote.description_in_scope_patterns),
    workArea: compileWorkArea({
      patterns: cfg.remote.work_area_patterns,
      titlePatterns: cfg.remote.work_area_title_patterns,
      anywhere: cfg.remote.work_area_anywhere_patterns,
      negation: cfg.remote.work_area_negation_patterns,
      continuations: cfg.remote.work_area_continuations,
      connectors: cfg.remote.work_area_connectors,
      endings: cfg.remote.work_area_endings,
      articles: cfg.remote.work_area_articles,
    }),
    geo,
    liveCountries: areas.liveCountries,
    liveOpen: areas.liveOpen,
    livePlaces: compileLivePlaces(areas.liveSpellings),
    seniorities,
    blacklistedCompanyKeys,
    watchedCompanyKeys: buildWatchedCompanyKeys(context.watchedCompanies ?? [], pipeline),
    keywords: preferences.exclude_keywords.map((keyword) => ({ keyword, pattern: wholeWordPattern(keyword) })),
    legalSuffixes: pipeline.company.legal_suffixes,
    dealBreakers: compileDealBreakers(preferences.deal_breakers, { language: market.language?.code ?? null, me: context.me, limits: cfg.deal_breakers, visa: visaRulesFor(pipeline) }),
    pipeline,
  };
}

/** "Austin, TX": the state codes of the countries outside the scope, after a comma, a dash or a slash (case-sensitive). */
function outsideStateCodes(market: Market, inScope: ReadonlySet<string> | null): RegExp | null {
  const codes = Object.entries(market.subdivisionCodes).flatMap(([country, list]) => (inScope === null || inScope.has(country) ? [] : list));
  return codes.length > 0 ? new RegExp(`[,\\-\u2013/]\\s*(?:${[...new Set(codes)].join("|")})\\b`, "u") : null;
}

// ---------------------------------------------------------------- location

/** The home country or no country stated: where a text that names only the country, or no place, can stand for a wanted place. */
const inHomeOrUnstated = (location: JobLocation, filter: CompiledFilter): boolean => location.countryCode === null || location.countryCode === filter.homeCountry;

const cityOf = (location: JobLocation): string => location.city?.trim() ?? "";

/** A named place holds a location when the location states one of its countries, or none. */
const inCountriesOf = (target: NamedTarget, location: JobLocation): boolean => target.countries === null || location.countryCode === null || target.countries.has(location.countryCode);

/**
 * The location is this place or a town of its metro area. Both the normalized city and the label are read ("Greater Munich
 * Metropolitan Area", "Munich, Bavaria, Germany", "Poing bei München"); the names have to stand alone as words.
 */
function namesPlace(location: JobLocation, target: NamedTarget): boolean {
  if (!inCountriesOf(target, location)) return false;
  const city = foldText(cityOf(location));
  if (city !== "" && (target.names.has(city) || target.names.has(city.split(",", 1)[0]?.trim() ?? city))) return true;
  const texts = [city, foldText(location.label)].filter((text) => text !== "");
  return texts.some((text) => target.patterns.some((p) => p.test(text)));
}

/** The location names the home city or a place I'd move to. */
const isWantedCity = (location: JobLocation, filter: CompiledFilter): boolean => filter.named.some((target) => target.relocate && namesPlace(location, target));

/** The location states a country that counts as a whole: one I'd move to, or the home country without a home city. */
function isWholeCountry(location: JobLocation, filter: CompiledFilter): boolean {
  const country = location.countryCode;
  return country !== null && (filter.moveCountries.has(country) || (filter.anywhereInHome && country === filter.homeCountry));
}

/** The location names only a country that may hold a wanted place ("Germany", "Deutschland", "bundesweit", or "Netherlands" with Amsterdam listed). */
function isCountryLevel(location: JobLocation, filter: CompiledFilter): boolean {
  const text = cityOf(location) !== "" ? cityOf(location) : location.label.trim();
  if (filter.cityCountryNames.has(foldText(text.replace(/\s*\([^)]*\)\s*$/u, "")))) return true;
  return inHomeOrUnstated(location, filter) && filter.countryLevel.some((p) => p.test(text));
}

/** The location names only a region that contains an allowed city ("Bavaria", "Bavaria, Germany"): the place itself is the region. */
function isRegionLevel(location: JobLocation, filter: CompiledFilter): boolean {
  const place = foldText(cityOf(location) !== "" ? cityOf(location) : location.label);
  const region = place.split(",", 1)[0]?.trim() ?? place;
  return filter.named.some((target) => target.relocate && inCountriesOf(target, location) && target.regions.has(region));
}

const placeOf = (location: JobLocation): string => (location.city?.trim() ? location.city.trim() : location.label.trim());

type ScopeClass = "in" | "out" | "unknown";

/** Whether a remote posting is based where check 1 wants it: home, a listed country or city, or under a wide label. */
function classifyRemoteLocation(location: JobLocation, filter: CompiledFilter): ScopeClass {
  if (filter.scopeCountries === null || filter.named.some((target) => namesPlace(location, target))) return "in";
  const country = location.countryCode;
  if (country !== null) return filter.scopeCountries.has(country) ? "in" : "out";
  const label = location.label;
  if (filter.worldwide.some((p) => p.test(label)) || filter.scopeWide.some((p) => p.test(label))) return "in";
  if (filter.outside.some((p) => p.test(label)) || filter.outsideStateCode?.test(label)) return "out";
  return "unknown";
}

/**
 * The region marker of a title that says the posting hires outside the remote scope ("Staff AI Engineer - US" -> "US"),
 * or null. A title that also names an in-scope region or country ("EMEA / Americas", "- Canada, Germany" with Germany in scope) has none.
 */
function titleOutsideMarker(title: string, filter: CompiledFilter): string | null {
  if (filter.scopeWide.some((p) => p.test(title)) || filter.worldwide.some((p) => p.test(title))) return null;
  const folded = foldText(title);
  if (filter.scopeNames.some((p) => p.test(title) || p.test(folded))) return null;
  for (const pattern of filter.titleOutside) {
    const match = pattern.exec(title);
    if (match) return match[0].replace(/^[\s\-–—|,(/:]+|[\s\-–—|,)/]+$/gu, "") || match[0].trim();
  }
  return null;
}

/**
 * The title marker names a country, alone or with a qualifier ("US", "Canada only", "US East Coast"): the longest run of its
 * words the tables read as a country. "East Coast" or "Americas" names none.
 */
function markerNamesCountry(marker: string, filter: CompiledFilter): boolean {
  const geo = placeGeo(filter.pipeline);
  const words = marker.split(/[\s\-–—]+/u).filter((word) => word !== "");
  for (let length = words.length; length > 0; length--) {
    for (let start = 0; start + length <= words.length; start++) {
      if (lookupPlace(words.slice(start, start + length).join(" "), geo)?.kind === "country") return true;
    }
  }
  return false;
}

interface PartialVerdict {
  excluded: string[];
  notes: string[];
}

/** One filter run's time for reading postings. The phrases can come from a user's pack, so one that is slow on a posting has to be stopped. */
export interface WorkAreaRun {
  readonly timeBox: TimeBox;
  /** Longest one posting may take (ms). */
  readonly jobMs: number;
  /** Milliseconds of stopped readings left in this run; used up, postings are not read for the rest of it. */
  left: number;
  /** Jobs whose posting was not read to its end: their verdicts must not be kept as final. */
  readonly unread: Set<number>;
}

/** What one job's reading needs: the run, and the reasons stored for the job, so a posting not read now keeps a hide it had. */
export interface WorkAreaContext {
  run: WorkAreaRun;
  jobId: number;
  previous?: readonly string[] | undefined;
}

/** Start a run with the deal-breakers' limits. */
export function startWorkAreaRun(filter: CompiledFilter, timeBox: TimeBox): WorkAreaRun {
  const { match_ms: jobMs, rule_budget_ms: left } = filter.pipeline.filter.deal_breakers;
  return { timeBox, jobMs, left, unread: new Set() };
}

/** The reading of a posting, or null when it was stopped or not reached. */
function readWithinBudget(job: FilterJob, filter: CompiledFilter, context?: WorkAreaContext): WorkAreaReading | null {
  const read = (): WorkAreaReading => readWorkArea(job.title, job.description, filter.workArea, filter.geo);
  if (context === undefined) return read();
  const { run, jobId } = context;
  if (run.left <= 0) {
    run.unread.add(jobId);
    return null;
  }
  let reading: WorkAreaReading | null = null;
  const finished = run.timeBox(() => {
    reading = read();
  }, run.jobMs);
  if (finished) return reading;
  run.left -= run.jobMs;
  run.unread.add(jobId);
  return null;
}

/** Check 2, on a remote job check 1 kept: a clear statement of somewhere I don't live and wouldn't move to hides it, unless the posting also names a place I would. Not sure keeps it with a note, which does not lower its rank. */
function checkWorkArea(job: FilterJob, filter: CompiledFilter, out: PartialVerdict, context?: WorkAreaContext): void {
  const reading = readWithinBudget(job, filter, context);
  const hidden = reading === null ? context?.previous?.find((reason) => reason.startsWith("remote_out_of_scope")) : undefined;
  if (hidden !== undefined) {
    out.excluded.push(hidden);
    return;
  }
  if (reading === null || !reading.sure) {
    out.notes.push(encodeReason("remote_area_unknown"));
    return;
  }
  if (reading.countries === null || reading.countries.some((country) => filter.liveCountries.has(country))) return;
  if (filter.liveOpen || namesLivePlace(job.title, job.description, filter.livePlaces)) out.notes.push(encodeReason("remote_area_unknown"));
  else out.excluded.push(encodeReason("remote_out_of_scope", reading.quote));
}

function checkLocation(job: FilterJob, filter: CompiledFilter, out: PartialVerdict, context?: WorkAreaContext): void {
  const excludedBefore = out.excluded.length;
  checkStatedLocation(job, filter, out);
  if (job.workplace === "remote" && out.excluded.length === excludedBefore) checkWorkArea(job, filter, out, context);
}

/**
 * The location rule. A location naming a wanted city settles it. Then, for a remote job, a title that says which region it hires in ("- US",
 * "US East Coast") wins over the locations and the description. A location in a country that counts as a whole gives way only to a title naming
 * another country: "East Coast" or "Americas" says nothing against it.
 */
function checkStatedLocation(job: FilterJob, filter: CompiledFilter, out: PartialVerdict): void {
  const locations = job.locations;
  if (locations.some((l) => isWantedCity(l, filter))) return;
  const marker = job.workplace === "remote" && filter.scopeCountries !== null ? titleOutsideMarker(job.title, filter) : null;
  const wholeCountry = locations.some((l) => isWholeCountry(l, filter));
  if (marker !== null && (!wholeCountry || markerNamesCountry(marker, filter))) {
    out.excluded.push(encodeReason("remote_out_of_scope", marker));
    return;
  }
  if (wholeCountry) return;

  const countryLevel = locations.find((l) => isCountryLevel(l, filter));
  const regionLevel = locations.find((l) => isRegionLevel(l, filter));
  const levelNote = (): string => encodeReason("location_country_level", placeOf((countryLevel ?? regionLevel) as JobLocation));

  if (job.workplace === "remote") {
    const classes = locations.map((l) => classifyRemoteLocation(l, filter));
    if (classes.includes("in")) {
      if (countryLevel) out.notes.push(levelNote());
      return;
    }
    const firstOut = locations.find((_, i) => classes[i] === "out");
    if (firstOut && !classes.includes("unknown")) {
      // located outside the scope, but the description may say it hires in the home country / region
      if (job.description !== null && filter.descriptionInScope.some((p) => p.test(job.description ?? ""))) {
        out.notes.push(encodeReason("remote_scope_description", placeOf(firstOut)));
        return;
      }
      out.excluded.push(encodeReason("remote_out_of_scope", placeOf(firstOut)));
      return;
    }
    out.notes.push(encodeReason("remote_scope_unknown"));
    return;
  }

  // on-site, hybrid, or a posting that does not say: it has to be in one of the allowed cities
  if (locations.length === 0) {
    out.notes.push(encodeReason("location_unknown"));
    return;
  }
  // a watched company's jobs are kept in any city of the home country: only a location that states the home country counts
  // (a place whose country cannot be read, "San Francisco", is stated but unknown to us, so it is not kept)
  const watched = isCompanyWatched({ watched: job.companyWatched, nameNorm: job.companyNameNorm ?? "" }, filter.watchedCompanyKeys);
  const keepWatched = (): boolean => {
    const home = watched ? locations.find((l) => l.countryCode === filter.homeCountry) : undefined;
    if (home === undefined) return false;
    out.notes.push(encodeReason("watched_company_location", placeOf(home)));
    return true;
  };
  // a location that names only the country or a region ("Germany", "Bavaria") may still be an allowed city; one that names a place ("Bochum") is not
  if (countryLevel || regionLevel) {
    if (job.workplace === "onsite" && filter.countryLevelOnsitePolicy === "exclude") {
      if (keepWatched()) return;
      out.excluded.push(encodeReason("location_not_allowed", placeOf((countryLevel ?? regionLevel) as JobLocation)));
      return;
    }
    out.notes.push(levelNote());
    return;
  }
  // a text that names no place at all ("Home Office", "multiple locations")
  const couldBeAllowed = locations.some((l) => cityOf(l) === "" && inHomeOrUnstated(l, filter) && filter.genericLocation.some((p) => p.test(l.label)));
  if (couldBeAllowed) {
    out.notes.push(encodeReason("location_unknown"));
    return;
  }
  if (keepWatched()) return;
  out.excluded.push(encodeReason("location_not_allowed", placeOf(locations[0] as JobLocation)));
}

// ---------------------------------------------------------------- other rules

function checkWorkplace(job: FilterJob, filter: CompiledFilter, out: PartialVerdict): void {
  if (job.workplace === "unknown") return;
  if (!filter.preferences.workplace.includes(job.workplace)) out.excluded.push(encodeReason("workplace_not_wanted", job.workplace));
}

function checkContract(job: FilterJob, filter: CompiledFilter, out: PartialVerdict): void {
  const prefs = filter.preferences;
  if (job.contract === "student") {
    if (prefs.exclude_student_roles) out.excluded.push(encodeReason("student_role"));
    return;
  }
  if (job.contract !== "permanent" && job.contract !== "fixed_term" && job.contract !== "freelance" && job.contract !== "temp_agency") return;
  const kind = job.contract;
  if (prefs.contracts.exclude.includes(kind)) out.excluded.push(encodeReason("contract_excluded", kind));
  else if (!prefs.contracts.allow.includes(kind)) out.excluded.push(encodeReason("contract_not_allowed", kind));
}

function checkSalary(job: FilterJob, filter: CompiledFilter, out: PartialVerdict): void {
  const below = salaryBelowFloor(job.salary, filter.preferences.salary_floor_year, filter.baseCurrency);
  if (below !== null) out.excluded.push(encodeReason("salary_below_floor", Math.round(below)));
}

function checkSeniority(job: FilterJob, filter: CompiledFilter, out: PartialVerdict): void {
  if (filter.seniorities === null || job.seniority === "unknown" || job.seniority === "") return;
  if (!filter.seniorities.includes(job.seniority)) out.excluded.push(encodeReason("seniority_mismatch", job.seniority));
}

function checkBlacklist(job: FilterJob, filter: CompiledFilter, out: PartialVerdict): void {
  if (isCompanyExcluded({ blacklisted: job.companyBlacklisted, name: job.companyName, aliases: job.companyAliases }, filter.blacklistedCompanyKeys, filter.legalSuffixes)) {
    out.excluded.push(encodeReason("blacklist_company", job.companyName));
  }
  if (filter.keywords.length === 0) return;
  const text = `${job.title}\n${job.description ?? ""}`;
  for (const { keyword, pattern } of filter.keywords) {
    if (pattern.test(text)) out.excluded.push(encodeReason("blacklist_keyword", keyword));
  }
}

function checkDealBreakerRules(filter: CompiledFilter, vetoes: readonly string[] | undefined, out: PartialVerdict): void {
  if (filter.dealBreakers.rules.length === 0) return;
  // the user's patterns run only inside a time box (`dealBreakerVetoes`), never here without one
  if (vetoes === undefined) throw new Error("evaluateJob: deal-breaker rules are compiled but no vetoes were passed (see dealBreakerVetoes)");
  for (const id of vetoes) out.excluded.push(encodeReason("deal_breaker", id));
}

/** The user's decision about one job's filter result (`job_filter_overrides`): keep a filtered job, or exclude a passed one. */
export type FilterOverride = "keep" | "exclude";

/** The verdict after the user's decision: the rules still run so the reasons they found stay on record. */
export function applyOverride(verdict: FilterVerdict, override: FilterOverride | null): FilterVerdict {
  if (override === null) return verdict;
  // keep: the reasons that excluded the job (or the notes of a job that passed anyway) stay after the marker
  if (override === "keep") return { result: "passed", reasons: [encodeReason("override_keep"), ...verdict.reasons] };
  return { result: "filtered_out", reasons: [encodeReason("override_exclude"), ...(verdict.result === "filtered_out" ? verdict.reasons : [])] };
}

/**
 * Evaluate one job. Excluded as soon as one rule says so; every rule that applies is listed. `dealBreakerVetoes`: the ids of
 * the deal-breakers that veto the job, from `dealBreakerVetoes` over its batch (required when the filter has deal-breakers).
 */
export function evaluateJob(job: FilterJob, filter: CompiledFilter, override: FilterOverride | null = null, dealBreakerVetoes?: readonly string[], workArea?: WorkAreaContext): FilterVerdict {
  const out: PartialVerdict = { excluded: [], notes: [] };
  checkLocation(job, filter, out, workArea);
  checkWorkplace(job, filter, out);
  checkContract(job, filter, out);
  checkSalary(job, filter, out);
  checkSeniority(job, filter, out);
  checkBlacklist(job, filter, out);
  checkDealBreakerRules(filter, dealBreakerVetoes, out);
  const verdict: FilterVerdict = out.excluded.length > 0 ? { result: "filtered_out", reasons: out.excluded } : { result: "passed", reasons: out.notes };
  return applyOverride(verdict, override);
}

import type { PipelineConfig, PreferencesConfig } from "@/lib/config";
import type { GermanLevel, JobLocation, JobSalary } from "@/lib/domain/types";
import { scopeCountries, scopeWidePatterns } from "@/lib/market/remote-scope";
import type { Market } from "@/lib/market/types";
import { buildBlacklistedCompanyKeys, isCompanyExcluded } from "@/lib/companies/marks";
import { visaRulesFor } from "@/lib/visa/rules";

import { compileDealBreakers, type CompiledDealBreakers, type DealBreakerMe } from "./deal-breakers";
import { encodeReason } from "./reasons";
import { salaryBelowFloor } from "./salary";

/**
 * The hard filter: pure rules over the fields the pipeline already normalized
 * (contract, salary per year in the base currency, locations, workplace, seniority), plus the user's own words and rules
 * (`exclude_keywords`, `deal_breakers`). Nothing here parses a job description for facts. What a posting does not state
 * never excludes it (C3): the job is kept and, where it matters, noted.
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

/** Lower case, accents folded, ß -> ss: "München" and "munchen" compare equal. */
export function foldText(value: string): string {
  return value
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("en")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * "Unterföhring" -> "unterfoehring": the spelling local sources use when they avoid a letter (the market pack's
 * `transliterations`).
 */
export function foldTransliterated(value: string, transliterations: Readonly<Record<string, string>>): string {
  let out = value;
  for (const [letter, spelling] of Object.entries(transliterations)) out = out.replace(new RegExp(letter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), spelling);
  return foldText(out);
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

export interface CompiledFilter {
  preferences: PreferencesConfig;
  /** Folded names of the allowed cities (preferences `locations`, their aliases and the towns of their metro areas). */
  allowedCities: ReadonlySet<string>;
  cityLabelPatterns: readonly RegExp[];
  /** Folded names of regions that contain an allowed city but are too coarse to say ("Bavaria"). */
  regions: ReadonlySet<string>;
  /** Texts that name only a country ("Germany"). */
  countryLevel: readonly RegExp[];
  countryLevelOnsitePolicy: "keep_note" | "exclude";
  genericLocation: readonly RegExp[];
  /** The market's home country: the only country a target city can be in. */
  homeCountry: string;
  /** The market's base currency: what the salary floor is in. */
  baseCurrency: string;
  /** Countries inside the remote scope; null = all (worldwide). */
  scopeCountries: ReadonlySet<string> | null;
  /** Location texts that name the scope as a whole ("EU", "Europe"). */
  scopeWide: readonly RegExp[];
  worldwide: readonly RegExp[];
  outside: readonly RegExp[];
  /** Region markers of a remote posting's title that say it hires outside the scope ("- US", "US East Coast"). */
  titleOutside: readonly RegExp[];
  /** `, NY` / `- TX` after a place: a state of a country outside the scope. Case-sensitive. */
  outsideStateCode: RegExp | null;
  /** Description phrases saying the posting hires in the home country / region. */
  descriptionInScope: readonly RegExp[];
  seniorities: readonly string[] | null;
  blacklistedCompanyKeys: ReadonlySet<string>;
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
}

const compilePatterns = (patterns: readonly string[]): RegExp[] => patterns.map((p) => new RegExp(p, "iu"));

/** Preferences + pipeline.yaml (+ me.yaml for a language gate) prepared for evaluating many jobs. */
export function compileFilter(preferences: PreferencesConfig, pipeline: PipelineConfig, context: FilterContext = { me: null }): CompiledFilter {
  const cfg = pipeline.filter;
  const market: Market = pipeline.market;
  const transliterations = market.transliterations;

  // spelling (folded) -> canonical name, for every city of city_aliases
  const canonicalOf = new Map<string, string>();
  const spellingsOf = new Map<string, string[]>();
  for (const [canonical, aliases] of Object.entries(cfg.city_aliases)) {
    const names = [canonical, ...aliases];
    spellingsOf.set(canonical, names);
    for (const name of names) canonicalOf.set(foldText(name), canonical);
  }
  const spellings = (name: string): string[] => spellingsOf.get(canonicalOf.get(foldText(name)) ?? "") ?? [name];

  const metroOf = new Map<string, string[]>();
  for (const [city, towns] of Object.entries(cfg.metro_areas)) {
    const key = foldText(canonicalOf.get(foldText(city)) ?? city);
    metroOf.set(key, [...(metroOf.get(key) ?? []), ...towns]);
  }
  const regionsOf = new Map<string, string[]>();
  for (const [city, regions] of Object.entries(cfg.metro_regions)) {
    const key = foldText(canonicalOf.get(foldText(city)) ?? city);
    regionsOf.set(key, [...(regionsOf.get(key) ?? []), ...regions]);
  }

  const allowed = new Set<string>();
  const regions = new Set<string>();
  for (const location of preferences.locations) {
    const canonical = canonicalOf.get(foldText(location)) ?? location;
    const addAllowed = (name: string): void => {
      allowed.add(foldText(name));
      allowed.add(foldTransliterated(name, transliterations));
    };
    for (const name of spellings(location)) addAllowed(name);
    for (const town of metroOf.get(foldText(canonical)) ?? []) for (const name of spellings(town)) addAllowed(name);
    for (const region of regionsOf.get(foldText(canonical)) ?? []) regions.add(foldText(region));
  }

  const blacklistedCompanyKeys = buildBlacklistedCompanyKeys(preferences.exclude_companies, pipeline);

  const seniorities = preferences.seniority === "all" ? null : cfg.seniority_map[preferences.seniority];

  return {
    preferences,
    allowedCities: allowed,
    cityLabelPatterns: [...allowed].map((name) => wholeWordPattern(name)),
    regions,
    countryLevel: compilePatterns(cfg.country_level.patterns),
    countryLevelOnsitePolicy: cfg.country_level.onsite_policy,
    genericLocation: compilePatterns(cfg.generic_location_patterns),
    homeCountry: market.country,
    baseCurrency: market.currency,
    scopeCountries: scopeCountries(preferences.remote_scope, market),
    scopeWide: compilePatterns(scopeWidePatterns(preferences.remote_scope, market)),
    worldwide: compilePatterns(cfg.remote.worldwide_patterns),
    outside: compilePatterns(cfg.remote.outside_patterns),
    titleOutside: compilePatterns(cfg.remote.title_outside_patterns),
    outsideStateCode: outsideStateCodes(market, scopeCountries(preferences.remote_scope, market)),
    descriptionInScope: compilePatterns(cfg.remote.description_in_scope_patterns),
    seniorities,
    blacklistedCompanyKeys,
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

/** The home country or no country stated: the only countries a target city (or its metro area) can be in. */
const inHomeOrUnstated = (location: JobLocation, filter: CompiledFilter): boolean => location.countryCode === null || location.countryCode === filter.homeCountry;

const cityOf = (location: JobLocation): string => location.city?.trim() ?? "";

/**
 * The location is a target city or a town of its metro area. Both the normalized city and the label
 * are read ("Greater Munich Metropolitan Area", "Munich, Bavaria, Germany", "Poing bei München"); the
 * names have to stand alone as words.
 */
function isAllowedCity(location: JobLocation, filter: CompiledFilter): boolean {
  if (!inHomeOrUnstated(location, filter)) return false;
  const city = foldText(cityOf(location));
  if (city !== "" && (filter.allowedCities.has(city) || filter.allowedCities.has(city.split(",", 1)[0]?.trim() ?? city))) return true;
  const texts = [city, foldText(location.label)].filter((text) => text !== "");
  return texts.some((text) => filter.cityLabelPatterns.some((p) => p.test(text)));
}

/** The location names only a country ("Germany", "Deutschland", "bundesweit"). */
function isCountryLevel(location: JobLocation, filter: CompiledFilter): boolean {
  if (!inHomeOrUnstated(location, filter)) return false;
  const text = cityOf(location) !== "" ? cityOf(location) : location.label.trim();
  return filter.countryLevel.some((p) => p.test(text));
}

/** The location names only a region that contains an allowed city ("Bavaria", "Bavaria, Germany"): the place itself is the region. */
function isRegionLevel(location: JobLocation, filter: CompiledFilter): boolean {
  if (!inHomeOrUnstated(location, filter)) return false;
  const place = foldText(cityOf(location) !== "" ? cityOf(location) : location.label);
  return filter.regions.has(place.split(",", 1)[0]?.trim() ?? place);
}

const placeOf = (location: JobLocation): string => (location.city?.trim() ? location.city.trim() : location.label.trim());

type ScopeClass = "in" | "out" | "unknown";

/** Whether a location of a remote posting is inside the remote scope of the preferences. */
function classifyRemoteLocation(location: JobLocation, filter: CompiledFilter): ScopeClass {
  if (filter.scopeCountries === null) return "in";
  const country = location.countryCode;
  if (country !== null) return filter.scopeCountries.has(country) ? "in" : "out";
  const label = location.label;
  if (filter.worldwide.some((p) => p.test(label)) || filter.scopeWide.some((p) => p.test(label))) return "in";
  if (filter.outside.some((p) => p.test(label)) || filter.outsideStateCode?.test(label)) return "out";
  return "unknown";
}

/**
 * The region marker of a title that says the posting hires outside the remote scope ("Staff AI Engineer - US" -> "US"),
 * or null. A title that also names an in-scope region ("EMEA / Americas") has none.
 */
function titleOutsideMarker(title: string, filter: CompiledFilter): string | null {
  if (filter.scopeWide.some((p) => p.test(title)) || filter.worldwide.some((p) => p.test(title))) return null;
  for (const pattern of filter.titleOutside) {
    const match = pattern.exec(title);
    if (match) return match[0].replace(/^[\s\-–—|,(/:]+|[\s\-–—|,)/]+$/gu, "") || match[0].trim();
  }
  return null;
}

interface PartialVerdict {
  excluded: string[];
  notes: string[];
}

function checkLocation(job: FilterJob, filter: CompiledFilter, out: PartialVerdict): void {
  const locations = job.locations;
  if (locations.some((l) => isAllowedCity(l, filter))) return;

  const countryLevel = locations.find((l) => isCountryLevel(l, filter));
  const regionLevel = locations.find((l) => isRegionLevel(l, filter));
  const levelNote = (): string => encodeReason("location_country_level", placeOf((countryLevel ?? regionLevel) as JobLocation));

  if (job.workplace === "remote") {
    const scope = filter.preferences.remote_scope;
    if (scope === "none") {
      out.excluded.push(encodeReason("remote_not_wanted"));
      return;
    }
    // the title says which region it hires in ("- US", "US East Coast"): that wins over locations and the description
    const marker = scope === "worldwide" ? null : titleOutsideMarker(job.title, filter);
    if (marker !== null) {
      out.excluded.push(encodeReason("remote_out_of_scope", marker));
      return;
    }
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
  // a location that names only the country or a region ("Germany", "Bavaria") may still be an allowed city; one that names a place ("Bochum") is not
  if (countryLevel || regionLevel) {
    if (job.workplace === "onsite" && filter.countryLevelOnsitePolicy === "exclude") {
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
export function evaluateJob(job: FilterJob, filter: CompiledFilter, override: FilterOverride | null = null, dealBreakerVetoes?: readonly string[]): FilterVerdict {
  const out: PartialVerdict = { excluded: [], notes: [] };
  checkLocation(job, filter, out);
  checkWorkplace(job, filter, out);
  checkContract(job, filter, out);
  checkSalary(job, filter, out);
  checkSeniority(job, filter, out);
  checkBlacklist(job, filter, out);
  checkDealBreakerRules(filter, dealBreakerVetoes, out);
  const verdict: FilterVerdict = out.excluded.length > 0 ? { result: "filtered_out", reasons: out.excluded } : { result: "passed", reasons: out.notes };
  return applyOverride(verdict, override);
}

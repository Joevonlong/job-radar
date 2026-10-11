import { z } from "zod";

import { CHANNEL_FAMILIES, SALARY_PERIODS } from "@/lib/channels/types";
import { SENIORITIES } from "@/lib/domain/types";

import { languageRequirementSchema, type LanguageRequirement } from "@/lib/market/schema";
import type { Market } from "@/lib/market/types";

import { nonEmptyString, nonNegativeInt, nonNegativeNumber, positiveInt, regexString } from "./common";

export { regexString } from "./common";

const regexList = z.array(regexString);
/** Lists the market packs also supply; the user file adds to them (union), so it may leave them out. */
const extraRegexList = regexList.default([]);
const extraStringList = z.array(nonEmptyString).default([]);
const extraMap = z.record(nonEmptyString, z.array(nonEmptyString)).default({});

const priority = z.number().int().min(1).max(100);

const amountRange = z.strictObject({ min: nonNegativeNumber, max: nonNegativeNumber }).refine((r) => r.min < r.max, "min must be below max");

const periodFactors = z.strictObject(Object.fromEntries(SALARY_PERIODS.map((p) => [p, z.number().positive()])) as Record<(typeof SALARY_PERIODS)[number], z.ZodNumber>);

/**
 * config/pipeline.yaml — normalization, deduplication and job lifecycle. This is the FILE;
 * the code reads the effective config (`loadPipeline()`: this file + the generic pack + the market's pack).
 * Lists that the packs also supply are optional here and are united with the packs' lists; maps are merged with the
 * file's keys winning.
 */
/** `lifecycle.watch_recheck` when the file has none. */
export const WATCH_RECHECK_DEFAULTS = {
  interval_hours: 72,
  max_per_cycle: 10,
  per_host_min_interval_ms: 3000,
  timeout_ms: 10000,
  max_body_bytes: 1_048_576,
  user_agent: "JobRadar/2 (self-hosted job tracker; link check)",
} as const;

export const pipelineSchema = z.strictObject({
  /** Raw postings parsed per database round trip; the step keeps going until none are pending. */
  batch_size: positiveInt,

  dedupe: z.strictObject({
    /** Two postings of the same company merge when their description SimHashes differ in at most this many of 64 bits. */
    simhash_max_distance: z.number().int().min(0).max(64),
    /** Words per shingle the SimHash is built from. */
    /** Same title and a related company name (one is a word-prefix of the other, or they share the first word: "SIV.AG" / "SIV.AG - Service für …", "Allianz in Deutschland" / "Allianz Kunde und Markt"): merge when the SimHash distance is within this many bits. Looser than `simhash_max_distance` because a StepStone and a LinkedIn copy of one JD differ in boilerplate. */
    cross_company_simhash_max_distance: z.number().int().min(0).max(64),
    simhash_shingle_words: positiveInt,
    /** Descriptions with fewer words get no SimHash (too short to compare reliably). */
    simhash_min_words: positiveInt,
  }),

  lifecycle: z.strictObject({
    /** An active job no source has returned for this many days becomes `possibly_closed`. */
    possibly_closed_after_days: positiveInt,
    /** Links of `possibly_closed` jobs checked per cycle (404 / 410 closes the job). */
    max_link_checks_per_cycle: nonNegativeInt,
    link_check_timeout_ms: positiveInt,
    /**
     * The recheck of watched jobs (starred, or an application the user follows): their posting is fetched like a careful
     * reader (robots.txt obeyed, one request per host every `per_host_min_interval_ms`). 404 / 410 closes the job; a "no longer
     * accepting" phrase in the page's visible text marks it possibly closed. Absent in older files: the defaults below.
     */
    watch_recheck: z
      .strictObject({
        /** A watched job is rechecked at most once in this many hours. */
        interval_hours: positiveInt,
        /** Watched jobs rechecked per maintenance run. */
        max_per_cycle: nonNegativeInt,
        /** Least time between two requests to the same host (robots.txt included). */
        per_host_min_interval_ms: nonNegativeInt,
        timeout_ms: positiveInt,
        /** Longest page read; the rest is not downloaded. */
        max_body_bytes: positiveInt,
        /** The User-Agent of the recheck and of the possibly-closed link check; its first word is the robots.txt product token. */
        user_agent: nonEmptyString,
      })
      .default(WATCH_RECHECK_DEFAULTS),
  }),

  /** "Apply" link priority per channel family; lower wins (company ATS 1 > LinkedIn 2 > boards 3 > aggregators 4). */
  apply_priority: z.strictObject(Object.fromEntries(CHANNEL_FAMILIES.map((f) => [f, priority])) as Record<(typeof CHANNEL_FAMILIES)[number], typeof priority>),

  company: z.strictObject({
    /** Trailing legal-form words removed from company names (lower case, compared after punctuation is stripped). Added to the packs'. */
    legal_suffixes: extraStringList,
    /** Canonical company name -> other spellings that resolve to it. */
    aliases: z.record(nonEmptyString, z.array(nonEmptyString)),
    /** Companies known to be recruiters / staffing agencies (names; legal suffixes are ignored). Added to the packs'. */
    agency_names: extraStringList,
  }),

  agency: z.strictObject({
    /** Matched against the company name. */
    company_name_patterns: extraRegexList,
    /** Matched against the title and the description: wording of a recruiter posting for a client ("on behalf of our client", "im Auftrag unseres Kunden"). */
    text_patterns: extraRegexList,
    /** A `text_patterns` match is ignored when its sentence also matches one of these (an employer saying it does not want agencies: "we do not accept unsolicited CVs from recruitment agencies"). */
    exclude_context_patterns: extraRegexList,
    /** How many characters before and after a match are searched for those (it never reaches back over a line break). */
    exclude_context_chars: positiveInt,
  }),

  /** Clean-up of descriptions a source delivers as one run of text with interface leftovers. */
  description: z.strictObject({
    /** Interface text a scraper left at the very end ("Show more Show less"); matched against the end of the text and cut off. */
    trailing_ui_patterns: regexList,
    /** Structure restoration for a long description that has no line break at all. */
    restore: z.strictObject({
      /** Descriptions shorter than this are left alone. */
      min_chars: positiveInt,
      /** A restored paragraph is closed at the first sentence end after this many characters. */
      paragraph_chars: positiveInt,
      /** Headings that start a new paragraph (matched as whole phrases, capitalised, at a sentence start or followed by ":"). */
      section_headings: z.array(nonEmptyString),
      /** Words (lower case, without the final dot) after which a dot does not end a sentence ("e.g.", "z.B.", "Dr."). */
      abbreviations: z.array(nonEmptyString),
      /** Bullet glyphs that became inline text; each starts a "- " line again. */
      bullet_glyphs: z.array(z.string().length(1)),
    }),
  }),

  /**
   * Work mode (onsite / hybrid / remote) read from the posting's own words when the source does not
   * state one (C3: only what the text says; two different modes in the text = unknown). `head` is
   * matched against the title, the location texts and the contract hint (short, so looser); `text`
   * against the description (strict: benefit lists and side remarks must not count).
   */
  workplace: z.strictObject({
    head: z.strictObject({ remote: regexList, hybrid: regexList, onsite: regexList }),
    text: z.strictObject({ remote: regexList, hybrid: regexList, onsite: regexList }),
    /** A `text` match is ignored when one of these stands before it in the same sentence ("not available as fully remote", "we do not offer remote-only roles"). */
    negation_patterns: regexList,
    /** How many characters before a match are searched for a negation. */
    negation_window_chars: positiveInt,
  }),

  /** Contract wording; every list is added to the packs' (`rules.yaml` `contract`). */
  contract: z.strictObject({
    /** Werkstudent, Praktikum, Ausbildung, thesis ... (title and contract hint only). */
    student: extraRegexList,
    /** Zeitarbeit, Arbeitnehmerüberlassung ... (title, hint, description, company name). */
    temp_agency: extraRegexList,
    /**
     * The posting says it is a direct hire by the client through a recruiter ("Vertragsart: Personalvermittlung"):
     * not temp agency work even when the recruiter's boilerplate mentions Zeitarbeit. The recruiter tag comes from `agency`.
     */
    direct_hire: extraRegexList,
    /** Freelance, freiberuflich ... (title and contract hint). */
    freelance: extraRegexList,
    /** Title, contract hint and description. */
    fixed_term: extraRegexList,
    permanent: extraRegexList,
  }),

  language: z.strictObject({
    /** Fewer words than this and the text language is taken from the channel's hint, else `unknown`. */
    min_words_for_detection: positiveInt,
    /**
     * The rules that read the local-language requirement come from the market pack (`language.yaml`
     * `requirement`, an ordered whole). A block here replaces the pack's when the language step is on.
     */
    requirement: languageRequirementSchema.optional(),
  }),

  salary: z.strictObject({
    /** Multiplier from the stated period to a year. Documented: month 12, week 52, day 260 (5 x 52), hour 2080 (8 h x 260). */
    periods_per_year: periodFactors,
    /**
     * The currency `fx_rates` are written in (before: always EUR, the key was `fx_to_eur`). Any two currencies
     * convert through it: from X to the base currency = `fx_rates[X] / fx_rates[base]` (the pivot's own rate is 1).
     */
    fx_pivot: z.string().regex(/^[A-Z]{3}$/, "must be an ISO 4217 code"),
    /** Units of `fx_pivot` per one unit of a currency (reference rates, updated by hand). A currency missing here is kept but not converted (no invented rates, C3). */
    fx_rates: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().positive()),
    /** A bare amount (no period named) is read as annual from this amount up; below it the period stays unknown. */
    assume_annual_from: nonNegativeNumber,
    /** Annual amounts (in the base currency) outside this range are flagged for review. */
    plausible_annual: z
      .strictObject({ min: nonNegativeNumber, max: nonNegativeNumber })
      .refine((r) => r.min < r.max, "min must be below max"),
    /** Stated amounts (as written, not per year) outside the range of their period are flagged for review: "EUR 60 / month" is a phone allowance, not a salary. */
    plausible_per_period: z.strictObject(
      Object.fromEntries(SALARY_PERIODS.map((p) => [p, amountRange])) as Record<(typeof SALARY_PERIODS)[number], typeof amountRange>,
    ),
    /** A salary is read from a description only next to one of these words (see `context_window_chars`). */
    description_context_patterns: regexList,
    /** An amount counts as a description salary only if a salary word is at most this many characters away. */
    context_window_chars: positiveInt,
    /** Words that make a nearby amount a benefit, not a salary (relocation, learning budget, phone allowance ...). */
    negative_context_patterns: regexList,
    /** How far around an amount `negative_context_patterns` is looked for; the nearer of salary word and negative word decides. */
    negative_context_window_chars: positiveInt,
    /**
     * Currencies of the places the user wants to work: an amount in any other currency is marked "possibly another
     * region's pay" (a USD range on a Berlin job is usually the New York range). Missing = the market's currency.
     */
    local_currencies: z.array(z.string().regex(/^[A-Z]{3}$/, "must be an ISO 4217 code")).min(1).optional(),
    /** JD phrases saying the stated pay is for another location ("our US benefits", "rates vary per country"): the salary is marked like a foreign currency. */
    other_region_patterns: regexList.default([]),
    /** The stated pay includes a variable part ("OTE", "on-target earnings"): the figure is not a base salary. Matched against the salary text and the JD. */
    variable_patterns: regexList.default([]),
  }),

  /**
   * Skill tags found in title + description. `aliases` are other names people write for the same skill in me.yaml
   * ("k8s", "Large Language Models"): they only matter for the skill-overlap cells of the job list, not for the
   * tagging, which is `pattern`.
   */
  skills: z.array(z.strictObject({ name: nonEmptyString, pattern: regexString, aliases: z.array(nonEmptyString).default([]) })),

  /** The hard filter; the user's own thresholds and lists are in preferences.yaml. */
  filter: z.strictObject({
    /** Canonical city name -> other spellings. A city from preferences.yaml `locations` is allowed under all of its spellings. */
    city_aliases: extraMap,
    /**
     * Metro areas: city from preferences.yaml `locations` (or its alias) -> towns that count as that city. A location
     * whose normalized city or label (LinkedIn style: "Berlin Metropolitan Area", "Munich, Bavaria, Germany") names the
     * city or one of these towns is the target city. Spellings of the towns can be given as separate entries.
     */
    metro_areas: extraMap,
    /**
     * Regions that contain a target city but are too coarse to say ("Bavaria"): city from `locations` -> region names.
     * Such a location is kept with the note `location_country_level` (see `country_level.onsite_policy`).
     */
    metro_regions: extraMap,
    country_level: z.strictObject({
      /** Location texts that name only the country ("Germany", "Deutschland", "bundesweit"); the whole text must match. Added to the pack's `country_level_patterns`. */
      patterns: extraRegexList,
      /** What to do with an on-site posting whose location is only a country or region: `keep_note` keeps it and marks it, `exclude` filters it. Remote, hybrid and unknown workplaces are always kept with the note. */
      onsite_policy: z.enum(["keep_note", "exclude"]),
    }),
    /** Location texts that name no place at all ("Home Office", "multiple locations"): a posting that has only these may still be in an allowed city, so it is kept and noted. */
    generic_location_patterns: extraRegexList,
    /** Added to the countries of the region `eu` (generic pack). Kept for files from before the market packs. */
    eu_countries: z.array(z.string().regex(/^[A-Z]{2}$/, "must be an ISO 3166-1 alpha-2 code")).default([]),
    remote: z.strictObject({
      /** Added to the location texts of the region `eu` (generic pack). Kept for files from before the market packs. */
      eu_wide_patterns: extraRegexList,
      /** Location text that says "anywhere in the world" (counts as in scope unless remote_scope is none). */
      worldwide_patterns: extraRegexList,
      /** Location text of regions outside the home region where no country code was found (USA, APAC ...): out of scope. */
      outside_patterns: extraRegexList,
      /**
       * Region markers in a remote posting's TITLE that say it hires outside the scope ("Staff AI Engineer - US",
       * "FDE - US East Coast", "(Americas)"): the posting is out of scope whatever its locations or description say,
       * unless the title also names a region of `eu_wide_patterns` / `worldwide_patterns`.
       */
      title_outside_patterns: extraRegexList,
      /** Added to the US state codes of the generic pack (`subdivision_codes.US`). Kept for files from before the market packs. */
      outside_state_codes: z.array(z.string().regex(/^[A-Z]{2}$/, "must be a two-letter code")).default([]),
      /**
       * Phrases of the job description that say the posting hires in Germany / the EU / Europe. A remote job whose
       * location is outside the scope is kept (with a note) when the description matches one of them.
       */
      description_in_scope_patterns: extraRegexList,
    }),
    /** preferences.yaml `seniority` -> job seniorities that match it (a posting that does not state one is kept). */
    seniority_map: z.strictObject({
      entry: z.array(z.enum(SENIORITIES)),
      mid: z.array(z.enum(SENIORITIES)),
      senior: z.array(z.enum(SENIORITIES)),
      lead: z.array(z.enum(SENIORITIES)),
    }),
  }),
});

/** pipeline.yaml as written (what `loadConfig("pipeline")` returns; only the settings page and migrations read it). */
export type PipelineFileConfig = z.infer<typeof pipelineSchema>;

/**
 * The effective pipeline config the code works with (`loadPipeline()`): pipeline.yaml united with the generic
 * pack and the market's pack. Lists hold the union, maps the merge; `language.requirement` is the pack's ordered
 * block (null when the local-language step is off); `market` is the resolved market (country, currency, geography).
 */
/** How a currency is written in a salary text (generic pack `rules.yaml` `salary.currencies`). */
export interface CurrencyTokens {
  code: string;
  /** Regular expression fragments matched as they are ("€", "\\$", "zł"). */
  symbols: readonly string[];
  /** Regular expression fragments that must not run on into a letter ("eur(?:os?)?", "usd"). */
  words: readonly string[];
}

export interface PipelineConfig extends Omit<PipelineFileConfig, "language" | "filter" | "salary"> {
  salary: Omit<PipelineFileConfig["salary"], "local_currencies"> & {
    /** The user's list, else the market's currency. */
    local_currencies: readonly string[];
    /** How each currency is written (generic pack + market pack). */
    currencies: readonly CurrencyTokens[];
  };
  language: {
    min_words_for_detection: number;
    /** Language code -> stopwords (generic + pack). */
    stopwords: Readonly<Record<string, readonly string[]>>;
    /** The local-language requirement rules; null = the step is off (no level is read, nothing is deducted). */
    requirement: LanguageRequirement | null;
  };
  filter: Omit<PipelineFileConfig["filter"], "eu_countries" | "remote"> & {
    remote: Omit<PipelineFileConfig["filter"]["remote"], "eu_wide_patterns" | "outside_state_codes">;
  };
  market: Market;
  /** "no longer accepting applications" phrases of the packs (generic + market), for the recheck of watched jobs. */
  closed_posting: { phrases: readonly string[] };
}

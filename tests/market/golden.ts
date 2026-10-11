/**
 * Golden: what the German (DE) market does today, over a large set of inputs (string literals of the
 * pipeline / filter / scoring tests and fixtures, plus hand-written edge cases in `golden-inputs.json`).
 *
 * `de-golden.json` was generated from main's code BEFORE the market packs existed (phase A, first commit) with the
 * frozen DE config of `tests/fixtures/config/defaults`. After the move into packs the same functions must return the
 * same values under the DE market; the only allowed difference is listed in `de-golden.test.ts`.
 *
 * `computeGolden` is the only part that follows the code's API as it changes; the inputs and the JSON stay frozen.
 */
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { buildScorePrompt, scoreOutputSchema } from "@/lib/ai/prompts/score";
import type { PipelineConfig, PreferencesConfig } from "@/lib/config";
import type { GermanLevel, JobLocation } from "@/lib/domain/types";
import { GERMAN_LEVELS } from "@/lib/domain/types";
import { compileFilter, evaluateJob, type FilterJob } from "@/lib/filter";
import { buildCityGroups } from "@/lib/jobs/city-groups";
import { isAgencyCompany, normalizeCompanyKey, resolveCompanyName } from "@/lib/pipeline/company";
import { detectAgency, detectContract } from "@/lib/pipeline/contract";
import { normalizeDraftLocations, normalizeLocation } from "@/lib/pipeline/geography";
import { detectLanguage, explicitRequiredGermanLevels, extractGermanLevel } from "@/lib/pipeline/language";
import { normalizeSalary } from "@/lib/pipeline/salary";
import { migrateRemoteScope } from "@/lib/market/remote-scope";
import { languagePenalty } from "@/lib/scoring/german";
import { scoreLanguageOf } from "@/lib/scoring/score-task";
import { createPriorityScorer } from "@/lib/scoring/priority";

import { shippedPipeline } from "../pipeline/helpers";
import { aiConfig, exampleMe, examplePreferences } from "../scoring/helpers";

export interface GoldenInputs {
  /** Short strings (one line, at most 140 characters): locations, titles, company names, salary texts, sentences. */
  short: string[];
  /** Job descriptions. */
  long: string[];
  /** Location labels (also in `short`) for the filter, the priority and the city dropdown. */
  locations: string[];
  /** Titles for the remote title markers and the contract. */
  titles: string[];
  companies: string[];
  salaryTexts: string[];
}

export const GOLDEN_DIR = path.resolve(import.meta.dirname, "../fixtures/market");

export function readGoldenInputs(): GoldenInputs {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, "golden-inputs.json"), "utf8")) as GoldenInputs;
}

/** The legacy remote scopes and what they are called today (keys of the golden). */
export const LEGACY_SCOPES = ["none", "eu_hire_in_de", "eu_any", "worldwide"] as const;
export type LegacyScope = (typeof LEGACY_SCOPES)[number];

/** Everything the golden records, computed under one configuration. */
export interface GoldenContext {
  pipeline: PipelineConfig;
  /** The DE preferences template with the given legacy scope. */
  preferences: (scope: LegacyScope) => PreferencesConfig;
}

export function deContext(): GoldenContext {
  return {
    pipeline: shippedPipeline(),
    // the legacy scope names map to the new values (market migration); the golden keys keep the old names
    preferences: (scope) => examplePreferences((raw) => void (raw.remote_scope = migrateRemoteScope(scope))),
  };
}


function filterJob(over: Partial<FilterJob>): FilterJob {
  return {
    title: "Applied AI Engineer",
    description: "Build LLM features for our platform.",
    companyName: "Northwind Labs GmbH",
    companyAliases: [],
    companyBlacklisted: false,
    locations: [],
    workplace: "hybrid",
    seniority: "senior",
    contract: "permanent",
    salary: null,
    ...over,
  };
}

const verdictText = (v: { result: string; reasons: readonly string[] }): string => `${v.result}|${v.reasons.join(",")}`;

/**
 * A salary as the golden recorded it (before the market packs): the base-currency figure (`basePerYear` / `baseCurrency`) is
 * the EUR figure under the German market; it is checked here and left out, so the record stays the old shape.
 */
const salaryText = (s: ReturnType<typeof normalizeSalary>): unknown => {
  if (s === null) return null;
  const { basePerYear, baseCurrency, ...rest } = s;
  if (baseCurrency !== "EUR" || JSON.stringify(basePerYear) !== JSON.stringify(s.eurPerYear)) return { ...rest, basePerYear, baseCurrency };
  return rest;
};

/** "Austin, TX": a US state code after a place (all 50 states and DC; DE stays Germany). */
export const US_STATE_LABEL = /[,\-–/]\s*(?:AL|AK|AZ|AR|CA|CO|CT|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|MA|MD|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/u;

/**
 * Rows of the city dropdown golden: only labels whose location the market packs do not change on purpose (a country
 * the old code left out, a US state code after a European city name). `legacyCountry` is the old code's country.
 */
export function cityRowEligible(label: string, legacyCountry: string | null): boolean {
  return legacyCountry !== null && !US_STATE_LABEL.test(label);
}

export interface Golden {
  location: Array<[string | null, string | null]>;
  draftLocations: Array<Array<[string, string | null, string | null, boolean]>>;
  companyKey: Record<string, string>;
  companyNorm: Record<string, string>;
  agencyCompany: boolean[];
  contractTitle: string[];
  levelShort: string[];
  long: Array<{ level: string; explicit: string[]; language: string; contract: string; agency: boolean; salary: unknown }>;
  salaryText: unknown[];
  filterLocation: Record<string, string[]>;
  filterTitle: Record<string, string[]>;
  filterDescription: Record<string, string[]>;
  filterSalary: string[];
  priority: Array<Record<string, number>>;
  penalty: Record<string, Record<string, number>>;
  cityGroups: unknown;
  prompt: { system: string; user: string; schema: unknown };
}

/** `legacyCountryOf`: the old code's country of a location label (from the golden), for picking the city dropdown rows. */
export function computeGolden(inputs: GoldenInputs, ctx: GoldenContext, legacyCountryOf: (label: string) => string | null = (label) => normalizeLocation(label, ctx.pipeline.market).countryCode): Golden {
  const pipeline = ctx.pipeline;
  const market = pipeline.market;
  const suffixes = pipeline.company.legal_suffixes;
  const loc = (label: string): JobLocation => normalizeLocation(label, market);
  const language = market.language?.code ?? null;

  const location = inputs.short.map((s): [string | null, string | null] => {
    const l = normalizeLocation(s, market);
    return [l.city, l.countryCode];
  });
  const draftLocations = inputs.locations.map((s) =>
    normalizeDraftLocations([
      { label: s, city: null, countryCode: null },
      { label: s, city: s.split(",", 1)[0]?.trim() ?? null, countryCode: null },
      { label: `${s} `, city: null, countryCode: market.country },
    ], market).map((l): [string, string | null, string | null, boolean] => [l.label, l.city, l.countryCode, l.isPrimary]),
  );

  // sparse: only the strings whose key a legal suffix (or an alias) changes; the company list in full
  const companyKey: Record<string, string> = {};
  const companyNorm: Record<string, string> = {};
  inputs.short.forEach((s, i) => {
    const key = normalizeCompanyKey(s, suffixes);
    if (key !== normalizeCompanyKey(s, []) || inputs.companies.includes(s)) companyKey[i] = key;
    const norm = resolveCompanyName(s, pipeline).nameNorm;
    if (norm !== key) companyNorm[i] = norm;
  });
  const agencyCompany = inputs.short.map((s) => isAgencyCompany(s, pipeline));
  const contractTitle = inputs.short.map((s) => detectContract({ title: s, contractHint: null, description: "", companyName: "" }, pipeline));
  const levelShort = inputs.short.map((s) => extractGermanLevel(s, pipeline));

  const long = inputs.long.map((t) => {
    const contract = detectContract({ title: "Engineer", contractHint: null, description: t, companyName: "Example" }, pipeline);
    return {
      level: extractGermanLevel(t, pipeline),
      explicit: [...explicitRequiredGermanLevels(t, pipeline)].sort(),
      language: detectLanguage(t, pipeline),
      contract,
      agency: detectAgency({ title: "Engineer", description: t, companyName: "Example", flagged: undefined }, pipeline, contract),
      salary: salaryText(normalizeSalary({ title: "Engineer", companyName: "Example", locations: [], workplace: "unknown", description: t, applyUrl: null, sourceUrl: null }, pipeline)),
    };
  });

  const salaryTextOut = inputs.salaryTexts.map((s) =>
    salaryText(normalizeSalary({ title: "Engineer", companyName: "Example", locations: [], workplace: "unknown", description: "", salaryText: s, applyUrl: null, sourceUrl: null }, pipeline)),
  );

  const filterLocation: Record<string, string[]> = {};
  const filterTitle: Record<string, string[]> = {};
  const filterDescription: Record<string, string[]> = {};
  for (const scope of LEGACY_SCOPES) {
    const compiled = compileFilter(ctx.preferences(scope), pipeline);
    filterLocation[scope] = inputs.locations.flatMap((s) =>
      (["onsite", "hybrid", "remote", "unknown"] as const).map((workplace) => verdictText(evaluateJob(filterJob({ locations: [loc(s)], workplace }), compiled))),
    );
    filterTitle[scope] = inputs.titles.map((title) => verdictText(evaluateJob(filterJob({ title, locations: [loc("Remote")], workplace: "remote" }), compiled)));
    filterDescription[scope] = inputs.long.map((description) =>
      verdictText(evaluateJob(filterJob({ description, locations: [loc("Remote - USA")], workplace: "remote" }), compiled)),
    );
  }
  const floorFilter = compileFilter(ctx.preferences("eu_hire_in_de"), pipeline);
  const filterSalary = [...inputs.long, ...inputs.salaryTexts].map((text, i) => {
    const salary =
      i < inputs.long.length
        ? normalizeSalary({ title: "Engineer", companyName: "Example", locations: [], workplace: "unknown", description: text, applyUrl: null, sourceUrl: null }, pipeline)
        : normalizeSalary({ title: "Engineer", companyName: "Example", locations: [], workplace: "unknown", description: "", salaryText: text, applyUrl: null, sourceUrl: null }, pipeline);
    return verdictText(evaluateJob(filterJob({ locations: [loc("Berlin")], salary }), floorFilter));
  });

  const ai = aiConfig();
  const me = exampleMe();
  const scorer = createPriorityScorer({
    priority: ai.scoring.priority,
    languagePenalty: ai.scoring.language_penalty,
    preferences: ctx.preferences("eu_hire_in_de"),
    keywordGroupTerms: ["Machine Learning Engineer", "AI Solutions Engineer", "KI-Entwickler"],
    pipeline,
    bonusCap: 15,
    me,
    now: new Date("2026-10-07T12:00:00Z"),
  });
  const levels: GermanLevel[] = ["unknown", "preferred", "B1", "B2", "C1", "C2"];
  const priority = inputs.locations.flatMap((s, i) =>
    (["onsite", "remote"] as const).map((workplace) => {
      const b = scorer({
        title: inputs.titles[i % inputs.titles.length] ?? "AI Engineer",
        locations: [loc(s)],
        workplace,
        seniority: "senior",
        germanLevel: levels[i % levels.length] ?? "unknown",
        signalBonus: i % 7,
        postedAt: null,
        firstSeenAt: new Date("2026-10-05T12:00:00Z"),
        locationUnclear: i % 5 === 0,
        countryLevel: i % 3 === 0,
      });
      // the breakdown's field order of the code before the market packs (the local-language gap was called germanGap)
      return { title: b.title, signals: b.signals, location: b.location, seniority: b.seniority, recency: b.recency, germanGap: b.languageGap, priority: b.priority };
    }),
  );

  const penalty: Record<string, Record<string, number>> = {};
  for (const own of ["none", "A1", "A2", "B1", "B2", "C1", "C2", "native"]) {
    const userMe = exampleMe((raw) => {
      raw.languages = own === "none" ? [{ en: "C1" }] : [{ en: "C1" }, { de: own }];
    });
    penalty[own] = Object.fromEntries(GERMAN_LEVELS.map((level) => [level, languagePenalty(level, userMe, ai.scoring.language_penalty, language)]));
  }

  const rows = inputs.locations.flatMap((s, i) => {
    const l = loc(s);
    return cityRowEligible(s, legacyCountryOf(s)) ? [{ jobId: i + 1, city: l.city ?? s, label: s, countryCode: l.countryCode }] : [];
  });
  const cityGroups = buildCityGroups(rows, { targets: ctx.preferences("eu_hire_in_de").locations, filter: pipeline.filter, market });

  const prompt = buildScorePrompt({
    me,
    preferences: ctx.preferences("eu_hire_in_de"),
    job: {
      title: "Senior AI Engineer (m/w/d)",
      company: "Northwind Labs",
      locations: ["Berlin, Germany"],
      workplace: "hybrid",
      seniority: "senior",
      contract: "permanent",
      salary: "€80,000 - €100,000",
      description: "Build LLM features. Gute Deutschkenntnisse (B2) erforderlich.",
    },
    jdMaxChars: 12000,
    jdHeadShare: 0.7,
    glossary: {},
    language: scoreLanguageOf(pipeline),
    currency: market.currency,
  });

  return {
    location,
    draftLocations,
    companyKey,
    companyNorm,
    agencyCompany,
    contractTitle,
    levelShort,
    long,
    salaryText: salaryTextOut,
    filterLocation,
    filterTitle,
    filterDescription,
    filterSalary,
    priority,
    penalty,
    cityGroups,
    prompt: { system: prompt.system, user: prompt.user, schema: z.toJSONSchema(scoreOutputSchema, { io: "output", target: "draft-2020-12" }) },
  };
}

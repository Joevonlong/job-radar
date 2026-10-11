/**
 * The code-side check of an AI salary lookup. The model's answer is untrusted (it read web pages): every source
 * URL is checked here on its own (https, a public host name, trusted when the host is on the configured list, else marked
 * "other source"), figures are converted to the base currency and range-checked, bands without a valid source are
 * dropped, and a lookup without any valid source is low confidence and never enters the benchmark.
 */
import { isIP } from "node:net";

import type { SalaryLookupBandOutput, SalaryLookupOutput } from "@/lib/ai/prompts/salary";
import { SENIORITIES } from "@/lib/domain/types";
import { fxFactor, type FxTable } from "@/lib/market/currency";

import type { SalaryBand, SalaryLookupQuery, SalaryLookupResult, SalaryObservation, SalarySource } from "./lookup-types";

export interface VerifyInput {
  output: SalaryLookupOutput;
  query: SalaryLookupQuery;
  fx: FxTable;
  /** `lookup.sanity_annual` plus `lookup.unconvertible_max_annual` (the loose cap of figures without an exchange rate). */
  sanity: Sanity;
  /** `lookup.allowed_fetch_domains`. */
  trustedDomains: readonly string[];
  /** The role family of a title (`compileFamilies(...).familyOf`). */
  familyOf: (title: string) => string | null;
  /** The family of the job itself (null: not in the benchmark). */
  jobFamily: string | null;
}

interface Sanity {
  min: number;
  max: number;
  unconvertibleMax: number;
}

const BLOCKED_HOST = /(^|\.)(localhost|local|internal|lan|home|corp|intranet|localdomain|example|invalid|test)$/i;

/** A public https URL (no credentials, no IP address, no local or reserved host name), or null. */
export function publicHttpsUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "" || !host.includes(".")) return null;
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0) return null;
  if (BLOCKED_HOST.test(host)) return null;
  if (url.port !== "" && url.port !== "443") return null;
  return url;
}

export function hostTrusted(host: string, domains: readonly string[]): boolean {
  const name = host.toLowerCase();
  return domains.some((domain) => name === domain || name.endsWith(`.${domain}`));
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** "Senior", "Staff Engineer (L5)" -> a `jobs.seniority` value, else unknown. */
export function seniorityOf(text: string | null): string {
  if (!text) return "unknown";
  const lower = text.toLowerCase();
  const order: Array<[string, RegExp]> = [
    ["intern", /\b(intern|praktikant|werkstudent)/],
    ["junior", /\b(junior|entry|graduate|jr\.?)\b/],
    ["principal", /\bprincipal\b/],
    ["staff", /\bstaff\b/],
    ["lead", /\b(lead|leiter)/],
    ["manager", /\b(manager|head|director)\b/],
    ["senior", /\b(senior|sr\.?)\b/],
    ["mid", /\b(mid|intermediate|regular)\b/],
  ];
  for (const [value, pattern] of order) if (pattern.test(lower)) return value;
  return (SENIORITIES as readonly string[]).includes(lower) ? lower : "unknown";
}

const ISO = /^[A-Z]{3}$/;

function convert(value: number | null, factor: number | null, sanity: { min: number; max: number }): number | null {
  if (value === null || factor === null) return null;
  const converted = value * factor;
  return converted >= sanity.min && converted <= sanity.max ? Math.round(converted) : null;
}

/** A band's figure in the base currency (median, else the middle of min and max, else the one bound); null when none. */
export function bandFigure(band: Pick<SalaryBand, "min" | "max" | "median">): number | null {
  if (band.median !== null) return band.median;
  if (band.min !== null && band.max !== null) return (band.min + band.max) / 2;
  return band.max ?? band.min ?? null;
}

function verifyBand(raw: SalaryLookupBandOutput, ctx: { indexMap: Map<number, number>; fx: FxTable; base: string; sanity: Sanity }): { band: SalaryBand | null; dropped: boolean } {
  const sources = [...new Set(raw.source_indexes.flatMap((index) => (ctx.indexMap.has(index) ? [ctx.indexMap.get(index) as number] : [])))];
  if (sources.length === 0) return { band: null, dropped: true };
  const code = raw.currency?.toUpperCase() ?? null;
  const factor = code !== null && ISO.test(code) ? fxFactor(code, ctx.base, ctx.fx) : null;
  const convertible = factor !== null;
  // without a rate there is no range check in the base currency: only a loose cap in the band's own currency
  const plausible = (value: number | null): number | null => (convertible || value === null || (value > 0 && value <= ctx.sanity.unconvertibleMax) ? value : null);
  const original = { min: plausible(raw.annual_min), max: plausible(raw.annual_max), median: plausible(raw.annual_median) };
  const min = convert(raw.annual_min, factor, ctx.sanity);
  const max = convert(raw.annual_max, factor, ctx.sanity);
  const median = convert(raw.annual_median, factor, ctx.sanity);
  // a figure the range check removed is gone for good; an unconvertible one is shown in its own currency only
  const anyOriginal = [original.min, original.max, original.median].some((value) => value !== null);
  const anyKept = [min, max, median].some((value) => value !== null);
  if (!anyOriginal || (convertible && !anyKept)) return { band: null, dropped: true };
  return {
    band: {
      title: clip(raw.title, 120),
      seniority: raw.seniority === null ? null : clip(raw.seniority, 40),
      min: convertible ? min : null,
      max: convertible ? max : null,
      median: convertible ? median : null,
      original: { ...original, currency: code !== null && ISO.test(code) ? code : null },
      convertible,
      basis: raw.basis,
      location: raw.location === null ? null : clip(raw.location, 120),
      sources,
    },
    dropped: false,
  };
}

const norm = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

/** The band's location names the job's city. */
export function cityMatches(location: string | null, city: string | null): boolean {
  return location !== null && city !== null && city.trim() !== "" && norm(location).includes(norm(city));
}

/** The band names the job's city or country (or its country's English name). */
export function placeMatches(location: string | null, query: Pick<SalaryLookupQuery, "city" | "country">): boolean {
  if (location === null) return false;
  const text = norm(location);
  if (cityMatches(location, query.city)) return true;
  if (query.country) {
    if (/^[a-z]{2}$/i.test(query.country) && new RegExp(`\\b${query.country.toLowerCase()}\\b`).test(text)) return true;
    try {
      const name = new Intl.DisplayNames(["en"], { type: "region" }).of(query.country);
      if (name && text.includes(norm(name))) return true;
    } catch {
      // an unknown code: no name to compare
    }
  }
  return false;
}

/** Check one answer. Never throws on content: what fails a check is dropped and counted. */
export function verifySalaryLookup(input: VerifyInput): SalaryLookupResult {
  const { output, query } = input;
  const base = query.currency;
  // sources: each URL on its own; the model's indexes are mapped onto the kept ones
  const sources: SalarySource[] = [];
  const indexMap = new Map<number, number>();
  const seen = new Map<string, number>();
  let dropped = 0;
  output.sources.forEach((source, index) => {
    const url = publicHttpsUrl(source.url);
    if (!url) {
      dropped += 1;
      return;
    }
    url.hash = "";
    const key = url.toString();
    const existing = seen.get(key);
    if (existing !== undefined) {
      indexMap.set(index, existing);
      return;
    }
    const host = url.hostname.toLowerCase();
    sources.push({ url: key, host, site: clip(source.site || host, 60), title: clip(source.title, 160), excerpt: clip(source.excerpt, 200), trusted: hostTrusted(host, input.trustedDomains) });
    seen.set(key, sources.length - 1);
    indexMap.set(index, sources.length - 1);
  });
  const ctx = { indexMap, fx: input.fx, base, sanity: input.sanity };

  const role = output.role_band ? verifyBand(output.role_band, ctx) : { band: null, dropped: false };
  if (role.dropped) dropped += 1;
  const related: SalaryBand[] = [];
  for (const raw of output.related_roles) {
    const checked = verifyBand(raw, ctx);
    if (checked.band) related.push(checked.band);
    else dropped += 1;
  }

  const companyCode = output.company_level.currency?.toUpperCase() ?? null;
  const companyFactor = companyCode !== null && ISO.test(companyCode) ? fxFactor(companyCode, base, input.fx) : null;
  const companySources = [...new Set(output.company_level.source_indexes.flatMap((index) => (indexMap.has(index) ? [indexMap.get(index) as number] : [])))];
  const companyMedian = companySources.length > 0 ? convert(output.company_level.annual_median, companyFactor, input.sanity) : null;

  const confidence = sources.length === 0 ? "low" : output.confidence;
  const result: SalaryLookupResult = {
    query,
    companyLevel: {
      level: companySources.length > 0 ? output.company_level.level : "unknown",
      median: companyMedian,
      summary: clip(output.company_level.summary, 300),
      sources: companySources,
    },
    roleBand: role.band,
    relatedRoles: related,
    sources,
    confidence,
    notes: clip(output.notes, 500),
    dropped,
    observations: [],
  };
  result.observations = observationsOf(result, input);
  return result;
}

/**
 * The bands that may enter the benchmark (`include_ai_lookups`): base salary, convertible, a figure, confidence medium
 * or high, at least one source on a trusted host, a known role family, and a location that names the job's city or
 * country. The observation carries the city only when the band's location names it (else it counts for the country).
 * One per family and seniority (duplicates removed).
 */
export function observationsOf(result: SalaryLookupResult, input: Pick<VerifyInput, "familyOf" | "jobFamily">): SalaryObservation[] {
  if (result.confidence === "low" || result.sources.length === 0) return [];
  const out: SalaryObservation[] = [];
  const seen = new Set<string>();
  const add = (band: SalaryBand, family: string | null, seniority: string): void => {
    if (family === null || band.basis !== "base" || !band.convertible) return;
    if (!band.sources.some((index) => result.sources[index]?.trusted === true)) return;
    if (!placeMatches(band.location, result.query)) return;
    const figure = bandFigure(band);
    if (figure === null) return;
    const key = `${family}|${seniority}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ family, seniority, city: cityMatches(band.location, result.query.city) ? result.query.city : null, country: result.query.country, figure });
  };
  if (result.roleBand) add(result.roleBand, input.jobFamily, result.query.seniority);
  for (const band of result.relatedRoles) add(band, input.familyOf(band.title), seniorityOf(band.seniority ?? band.title));
  return out;
}

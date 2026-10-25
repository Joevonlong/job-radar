/**
 * The code-side check of an AI salary lookup. The model's answer is untrusted (it read web pages): every source
 * URL is checked here on its own (https, a public host name, trusted when the host is on the configured list, else marked
 * "other source"), figures are converted to the base currency and range-checked, bands without a valid source are
 * dropped, and a lookup without any valid source is low confidence. Lookup results never enter the benchmark.
 */
import { isIP } from "node:net";

import type { SalaryLookupBandOutput, SalaryLookupOutput } from "@/lib/ai/prompts/salary";
import { fxFactor, type FxTable } from "@/lib/market/currency";

import type { SalaryBand, SalaryLookupQuery, SalaryLookupResult, SalarySource } from "./lookup-types";

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

const ISO = /^[A-Z]{3}$/;

function convert(value: number | null, factor: number | null, sanity: { min: number; max: number }): number | null {
  if (value === null || factor === null) return null;
  const converted = value * factor;
  return converted >= sanity.min && converted <= sanity.max ? Math.round(converted) : null;
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
  return result;
}

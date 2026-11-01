import { z } from "zod";

import { remoteLocationFor } from "@/lib/market/remote-scope";

import type { ChannelMarket } from "../../market";
import { searchKind } from "../../query";
import type { SearchQuery } from "../../types";

/**
 * Bright Data Web Scraper API contract for "LinkedIn job listings - discover by keyword"
 * (ported from the legacy connector's contract; approval/policy gates removed).
 * Flow: POST /datasets/v3/trigger -> GET /datasets/v3/progress/{id} -> GET /datasets/v3/snapshot/{id}.
 * Everything tunable (dataset id, price, polling, timeout, country, remote locations) lives in sources.yaml.
 */

export const BRIGHTDATA_API_ORIGIN = "https://api.brightdata.com";
/** Environment variable holding the API key (read at collect time, never logged). */
export const BRIGHTDATA_API_KEY_ENV = "BRIGHT_DATA_API_KEY";

/**
 * Fields requested from the provider (`custom_output_fields`): the minimum the pipeline needs. Names must exist in the
 * dataset schema (`GET /datasets/{dataset_id}/metadata`); the API answers 500 for an unknown one. The dataset has no
 * workplace-type field (the legacy contract listed one that no longer exists) and `job_poster` is private data we never ask for.
 * `job_summary` is the description as one run of plain text (no line breaks, ends with "Show more Show less");
 * `job_description_formatted` is the same text as HTML with its paragraphs and lists, which the parser prefers.
 */
export const BRIGHTDATA_OUTPUT_FIELDS = [
  "url",
  "job_posting_id",
  "job_title",
  "company_name",
  "company_id",
  "job_location",
  "job_summary",
  "job_description_formatted",
  "job_seniority_level",
  "job_employment_type",
  "apply_link",
  "country_code",
  "job_posted_date",
  "job_base_pay_range",
  "base_salary",
  "discovery_input",
] as const;

/** Provider limits: `limit_per_input` is 1..100, the keyword field 200 characters, one trigger takes at most 8 inputs. */
export const MAX_LIMIT_PER_INPUT = 100;
export const MAX_KEYWORD_CHARS = 200;
export const MAX_INPUTS_PER_TRIGGER = 8;
/** Safety cap on one downloaded snapshot. */
export const MAX_RESPONSE_CHARS = 20 * 1024 * 1024;

/** The discrete `time_range` values the provider offers, from the narrowest. */
const TIME_RANGES = [
  { maxHours: 24, label: "Past 24 hours" },
  { maxHours: 24 * 7, label: "Past week" },
  { maxHours: 24 * 30, label: "Past month" },
] as const;

/** Smallest provider range covering `windowHours`; `label` is undefined (no filter) beyond a month. */
export function timeRangeFor(windowHours: number): { label: string | undefined; rangeHours: number } {
  const range = TIME_RANGES.find((r) => windowHours <= r.maxHours);
  return range ? { label: range.label, rangeHours: range.maxHours } : { label: undefined, rangeHours: Number.POSITIVE_INFINITY };
}

// ---------------------------------------------------------------- settings (sources.yaml: linkedin.brightdata)

export const brightDataSettingsSchema = z.object({
  dataset_id: z.string().min(1),
  cost_per_1k_usd: z.number().min(0),
  poll_interval_ms: z.number().int().positive(),
  timeout_ms: z.number().int().positive(),
  /** Empty or missing = the market's home country. */
  country: z.string().regex(/^(?:[A-Z]{2})?$/).optional(),
  /** Per remote scope kind; a missing key follows the market (country name, region name, "Worldwide"). */
  remote_locations: z
    .object({ home_country: z.string().optional(), region: z.string().optional(), worldwide: z.string().optional() })
    .default({}),
});
export type BrightDataSettings = z.infer<typeof brightDataSettingsSchema>;

// ---------------------------------------------------------------- request

export const discoveryInputSchema = z.strictObject({
  location: z.string().min(1).max(120),
  keyword: z.string().min(1).max(MAX_KEYWORD_CHARS),
  country: z.string().regex(/^[A-Z]{2}$/),
  time_range: z.string().min(1).max(80).optional(),
  remote: z.string().min(1).max(80).optional(),
});
export type DiscoveryInput = z.infer<typeof discoveryInputSchema>;

/** `"A" OR "B"` terms packed into as few keyword strings as the provider's length limit allows. */
export function keywordStrings(keywords: readonly string[]): string[] {
  const terms = keywords.map((k) => `"${k.replaceAll('"', "").trim()}"`).filter((t) => t.length > 2);
  const out: string[] = [];
  let current = "";
  for (const term of terms) {
    const next = current === "" ? term : `${current} OR ${term}`;
    if (next.length <= MAX_KEYWORD_CHARS) {
      current = next;
    } else {
      if (current !== "") out.push(current);
      current = term.length <= MAX_KEYWORD_CHARS ? term : term.slice(0, MAX_KEYWORD_CHARS);
    }
  }
  if (current !== "") out.push(current);
  return out;
}

/** Whether the query has anything to search for: a company name made only of quote characters has not. */
export function hasSearchableKeywords(query: SearchQuery): boolean {
  return keywordStrings(query.keywords).length > 0;
}

/** The provider inputs for one query: one per keyword string (usually exactly one). A company query searches the home country, without a remote filter. */
export function buildDiscoveryInputs(query: SearchQuery, settings: BrightDataSettings, market: ChannelMarket): DiscoveryInput[] {
  const kind = searchKind(query);
  const location = kind === "company" ? market.countryName : kind === "remote" ? remoteLocationFor(query.remoteScope ?? "worldwide", settings.remote_locations, market) : query.location;
  if (location === null) throw new Error("brightdata: a located query needs a location");
  const timeRange = timeRangeFor(query.windowHours).label;
  const inputs = keywordStrings(query.keywords).map((keyword) =>
    discoveryInputSchema.parse({
      location,
      keyword,
      country: settings.country || market.country,
      ...(timeRange === undefined ? {} : { time_range: timeRange }),
      ...(kind === "remote" ? { remote: "Remote" } : {}),
    }),
  );
  if (inputs.length === 0) throw new Error("brightdata: the query has no keywords");
  if (inputs.length > MAX_INPUTS_PER_TRIGGER) throw new Error("brightdata: the keyword group needs more inputs than one trigger allows");
  return inputs;
}

export function triggerUrl(datasetId: string, limitPerInput: number, origin = BRIGHTDATA_API_ORIGIN): string {
  if (!Number.isInteger(limitPerInput) || limitPerInput < 1 || limitPerInput > MAX_LIMIT_PER_INPUT) {
    throw new RangeError(`limit_per_input must be an integer from 1 to ${MAX_LIMIT_PER_INPUT}`);
  }
  const url = new URL("/datasets/v3/trigger", origin);
  url.searchParams.set("dataset_id", datasetId);
  url.searchParams.set("type", "discover_new");
  url.searchParams.set("discover_by", "keyword");
  url.searchParams.set("include_errors", "true");
  url.searchParams.set("limit_per_input", String(limitPerInput));
  url.searchParams.set("custom_output_fields", BRIGHTDATA_OUTPUT_FIELDS.join("|"));
  url.searchParams.set("format", "json");
  return url.toString();
}

export function progressUrl(snapshotId: string, origin = BRIGHTDATA_API_ORIGIN): string {
  return new URL(`/datasets/v3/progress/${snapshotId}`, origin).toString();
}

export function snapshotUrl(snapshotId: string, origin = BRIGHTDATA_API_ORIGIN): string {
  const url = new URL(`/datasets/v3/snapshot/${snapshotId}`, origin);
  url.searchParams.set("format", "json");
  return url.toString();
}

// ---------------------------------------------------------------- responses

/** Snapshot ids look like `s_m4x7enmven8djfqak` (docs show `sd_...`); anything else never reaches a URL path. */
export const snapshotIdSchema = z.string().regex(/^[a-z]{1,3}_[a-z0-9]{8,80}$/i);
export const triggerResponseSchema = z.object({ snapshot_id: snapshotIdSchema });

/** `starting | running | ready | failed | canceled`; legacy also saw `collecting` and `digesting`: unknown values keep polling. */
export const progressResponseSchema = z.object({ status: z.string().min(1) });

const optionalText = z.string().nullish();

/** One job record as delivered. Unknown fields are kept (the raw payload is stored verbatim, C1). */
export const jobRecordSchema = z.looseObject({
  url: z.string().min(1),
  job_posting_id: z.union([z.string(), z.number()]).transform(String),
  job_title: z.string().trim().min(1),
  company_name: z.string().trim().min(1),
  company_id: z.union([z.string(), z.number()]).transform(String).nullish(),
  job_location: optionalText,
  job_summary: optionalText,
  job_description_formatted: optionalText,
  job_seniority_level: optionalText,
  job_employment_type: optionalText,
  apply_link: optionalText,
  country_code: optionalText,
  job_posted_date: optionalText,
  job_base_pay_range: optionalText,
  base_salary: z
    .looseObject({
      currency: optionalText,
      min_amount: z.number().finite().nonnegative().nullish(),
      max_amount: z.number().finite().nonnegative().nullish(),
      payment_period: optionalText,
    })
    .nullish(),
});
export type JobRecord = z.infer<typeof jobRecordSchema>;

/** A record the provider delivers when one input failed (`include_errors=true`): no job, an `error` field. */
export function isProviderErrorRecord(item: unknown): boolean {
  return typeof item === "object" && item !== null && !Array.isArray(item) && "error" in item && !("job_posting_id" in item);
}

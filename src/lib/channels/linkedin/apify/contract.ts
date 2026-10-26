import { z } from "zod";

import { remoteLocationFor } from "@/lib/market/remote-scope";

import type { ChannelMarket } from "../../market";
import type { SearchQuery } from "../../types";
import { keywordStrings } from "../brightdata/contract";

/**
 * Apify API v2 contract for the LinkedIn Apify channel. One query = one synchronous run:
 * `POST /v2/acts/{actor}/run-sync-get-dataset-items` answers 201 with the dataset items (the actor must finish within
 * Apify's 300 s limit, else 408). The actor, its input template, the prices and the limits all live in sources.yaml
 * (`linkedin.apify`): switching actors is a config change. The default actor is documented in
 * `research/linkedin-apify-actors-2026-10.md`.
 */

/** Environment variable holding the Apify API token (read at collect time, never logged). */
export const APIFY_TOKEN_ENV = "APIFY_TOKEN";
export const APIFY_API_ORIGIN = "https://api.apify.com";
/** Apify answers 408 for a synchronous run that exceeds this; it is the API's limit, not a tunable. */
export const APIFY_SYNC_LIMIT_SECS = 300;
/** Safety cap on one downloaded dataset. */
export const MAX_RESPONSE_CHARS = 20 * 1024 * 1024;
/** LinkedIn's guest search keyword field is about this long (same limit the Bright Data input has). */
export const MAX_KEYWORD_CHARS = 200;

/** `username/actor-name` (or `username~actor-name`) or a 17-character actor id; empty = not configured yet. */
export const ACTOR_ID_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*[/~][A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9]{17})?$/;

// ---------------------------------------------------------------- settings (sources.yaml: linkedin.apify)

export const apifyDatePostedSchema = z.strictObject({
  /** Value of the `{date_posted}` placeholder for a look-back window of at most 24 hours. */
  day: z.string(),
  /** ... at most 7 days. */
  week: z.string(),
  /** ... at most 30 days. */
  month: z.string(),
  /** ... longer than 30 days (empty string = the key is left out of the input). */
  any: z.string(),
});

export const apifySettingsSchema = z.object({
  actor_id: z.string().trim().regex(ACTOR_ID_PATTERN),
  api_base_url: z.url({ protocol: /^https?$/ }),
  price_per_1k_usd: z.number().min(0),
  run_start_usd: z.number().min(0),
  memory_mb: z.number().int().positive(),
  timeout_secs: z.number().int().positive().max(APIFY_SYNC_LIMIT_SECS),
  /** Empty or missing = the market's home country. */
  country_name: z.string().trim().optional(),
  /** Per remote scope kind; a missing key follows the market (country name, region name, "Worldwide"). */
  remote_locations: z
    .object({ home_country: z.string().optional(), region: z.string().optional(), worldwide: z.string().optional() })
    .default({}),
  date_posted: apifyDatePostedSchema,
  input_template: z.record(z.string(), z.unknown()),
  remote_input: z.record(z.string(), z.unknown()),
});
export type ApifySettings = z.infer<typeof apifySettingsSchema>;

// ---------------------------------------------------------------- request

/** The discrete LinkedIn look-back filters, from the narrowest. */
const DATE_RANGES = [
  { key: "day", maxHours: 24 },
  { key: "week", maxHours: 24 * 7 },
  { key: "month", maxHours: 24 * 30 },
] as const;

export type DateRangeKey = (typeof DATE_RANGES)[number]["key"] | "any";

/** Smallest LinkedIn filter covering `windowHours`; `any` (no filter) beyond a month. */
export function dateRangeFor(windowHours: number): { key: DateRangeKey; rangeHours: number } {
  const range = DATE_RANGES.find((r) => windowHours <= r.maxHours);
  return range ? { key: range.key, rangeHours: range.maxHours } : { key: "any", rangeHours: Number.POSITIVE_INFINITY };
}

export interface TemplateValues {
  keywords: string;
  location: string;
  limit: number;
  datePosted: string;
}

const PLACEHOLDER = /\{(keywords|location|limit|date_posted)\}/g;

function fill(value: unknown, values: Pick<TemplateValues, "keywords" | "location" | "limit" | "datePosted">): unknown {
  if (typeof value === "string") {
    // a string that is exactly "{limit}" becomes a number, so the actor's integer field stays an integer
    if (value === "{limit}") return values.limit;
    return value.replace(PLACEHOLDER, (_match, name: string) => {
      switch (name) {
        case "keywords":
          return values.keywords;
        case "location":
          return values.location;
        case "limit":
          return String(values.limit);
        default:
          return values.datePosted;
      }
    });
  }
  if (Array.isArray(value)) return value.map((entry) => fill(entry, values));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const filled = fill(entry, values);
      // an empty string means "no value" (e.g. date_posted.any): the key is left out
      if (filled !== "") out[key] = filled;
    }
    return out;
  }
  return value;
}

/** The location sent to the actor: `City, Country` for a located query, the configured location for a remote one. */
export function locationFor(query: SearchQuery, settings: Pick<ApifySettings, "remote_locations" | "country_name">, market: ChannelMarket): string {
  if (query.remote) return remoteLocationFor(query.remoteScope ?? "worldwide", settings.remote_locations, market);
  if (query.location === null) throw new Error("apify: a located query needs a location");
  return `${query.location}, ${settings.country_name || market.countryName}`;
}

/** The actor inputs for one query: one per keyword string (usually exactly one), from the configured template. */
export function buildActorInputs(
  query: SearchQuery,
  settings: Pick<ApifySettings, "input_template" | "remote_input" | "date_posted" | "remote_locations" | "country_name">,
  limit: number,
  market: ChannelMarket,
): Array<Record<string, unknown>> {
  const keywords = keywordStrings(query.keywords);
  if (keywords.length === 0) throw new Error("apify: the query has no keywords");
  const range = dateRangeFor(query.windowHours);
  const template = query.remote ? { ...settings.input_template, ...settings.remote_input } : settings.input_template;
  return keywords.map((keyword) => {
    const input = fill(template, { keywords: keyword, location: locationFor(query, settings, market), limit, datePosted: settings.date_posted[range.key] });
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("apify: input_template must be an object");
    return input as Record<string, unknown>;
  });
}

/** `username/actor` -> `username~actor` (the form the API path takes). */
export function actorPathSegment(actorId: string): string {
  return actorId.trim().replace("/", "~");
}

export interface RunUrlOptions {
  actorId: string;
  /** Hard cap of chargeable dataset items (pay-per-result / pay-per-event actors stop there). */
  maxItems: number;
  /** Hard cap of the run's total charge in USD (the platform aborts the run beyond it). */
  maxTotalChargeUsd: number;
  memoryMb: number;
  timeoutSecs: number;
  origin?: string;
}

export function runSyncUrl(options: RunUrlOptions): string {
  if (!Number.isInteger(options.maxItems) || options.maxItems < 1) throw new RangeError("maxItems must be a positive integer");
  const url = new URL(`/v2/acts/${actorPathSegment(options.actorId)}/run-sync-get-dataset-items`, options.origin ?? APIFY_API_ORIGIN);
  url.searchParams.set("format", "json");
  url.searchParams.set("timeout", String(options.timeoutSecs));
  url.searchParams.set("memory", String(options.memoryMb));
  url.searchParams.set("maxItems", String(options.maxItems));
  url.searchParams.set("maxTotalChargeUsd", String(Math.round(options.maxTotalChargeUsd * 1e6) / 1e6));
  return url.toString();
}

// ---------------------------------------------------------------- response

const optionalText = z.string().nullish();
const idValue = z.union([z.string(), z.number()]).transform((v) => String(v).trim());

/**
 * One job record of the default actor (`valig/linkedin-jobs-scraper`, documented output). Unknown fields are kept
 * (the raw payload is stored verbatim, C1). Only title and company are mandatory; the job id comes from `id` or,
 * failing that, from the URL.
 */
export const jobItemSchema = z.looseObject({
  id: idValue.nullish(),
  url: optionalText,
  title: z.string().trim().min(1),
  companyName: z.string().trim().min(1),
  companyUrl: optionalText,
  location: optionalText,
  description: optionalText,
  descriptionHtml: optionalText,
  salary: optionalText,
  postedDate: optionalText,
  contractType: optionalText,
  experienceLevel: optionalText,
  applyType: optionalText,
});
export type JobItem = z.infer<typeof jobItemSchema>;

/** LinkedIn job ids are 7+ digits; `/jobs/view/<slug>-<id>` and `/jobs/view/<id>` both occur. */
const URL_JOB_ID = /\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,})(?:[/?#]|$)/;

/** The numeric LinkedIn job id of an item: the same value Bright Data delivers as `job_posting_id` (so same-source dedupe matches). */
export function jobIdOf(item: { id?: string | null | undefined; url?: string | null | undefined }): string | null {
  const id = item.id?.trim();
  if (id && /^\d{6,}$/.test(id)) return id;
  if (item.url) {
    try {
      const match = URL_JOB_ID.exec(new URL(item.url).pathname);
      if (match?.[1]) return match[1];
    } catch {
      // not a URL
    }
  }
  return null;
}

/** `jobIdOf` for a record that has not been validated (any field may be missing or of another type). */
export function jobIdOfRecord(record: Record<string, unknown>): string | null {
  const id = record.id;
  return jobIdOf({
    id: typeof id === "string" || typeof id === "number" ? String(id) : null,
    url: typeof record.url === "string" ? record.url : null,
  });
}

/** An item the actor pushes when something failed: an `error` field and no job. */
export function isErrorItem(item: unknown): boolean {
  return typeof item === "object" && item !== null && !Array.isArray(item) && "error" in item && !("title" in item);
}

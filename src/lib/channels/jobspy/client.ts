import { z } from "zod";

import type { ChannelsConfig } from "@/lib/config";
import { remoteLocationFor } from "@/lib/market/remote-scope";

import { ChannelError } from "../errors";
import { searchKind } from "../query";
import { indeedCountryOf, marketForChannel, type ChannelMarket } from "../market";
import type { ChannelContext, RawPostingInput, SearchQuery } from "../types";

/**
 * Client for the python-jobspy sidecar (`jobspy/`). One client serves the three
 * channels `linkedin-guest`, `indeed` and `jobspy-google`; they differ only in the `site` they ask for.
 */

export const JOBSPY_SITES = ["linkedin", "indeed", "google"] as const;
export type JobspySite = (typeof JOBSPY_SITES)[number];

/** `sources.yaml: jobspy` with what follows the market filled in: the Indeed country and the market for remote locations. */
export type JobspySettings = ChannelsConfig["jobspy"] & { country_indeed: string; market: ChannelMarket };

/** Environment override for `jobspy.url` (compose points the runner at `http://jobspy:8000`). */
export const JOBSPY_URL_ENV = "JOBSPY_URL";

const baseUrlSchema = z.url({ protocol: /^https?$/ });

/** The sidecar URL: `JOBSPY_URL` when set (empty = unset), else `jobspy.url`; no trailing slash. */
export function resolveJobspyUrl(settings: Pick<ChannelsConfig["jobspy"], "url">, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const override = env[JOBSPY_URL_ENV];
  const candidate = override !== undefined && override.trim() !== "" ? override.trim() : settings.url;
  const parsed = baseUrlSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ChannelError("unknown", `${override ? JOBSPY_URL_ENV : "jobspy.url"} is not a valid http(s) URL`, { retryable: false });
  }
  return parsed.data.replace(/\/+$/, "");
}

/**
 * Sidecar settings with `JOBSPY_URL` applied (empty = unset) and the Indeed country of the market when `country_indeed`
 * is empty. The result's `url` has no trailing slash. A market without an Indeed site leaves `country_indeed`
 * empty: only an Indeed search fails for that (`buildSearchRequest`), LinkedIn and Google searches do not need it.
 */
export function resolveJobspySettings(
  settings: ChannelsConfig["jobspy"],
  env: Readonly<Record<string, string | undefined>> = process.env,
  market: ChannelMarket = marketForChannel(),
): JobspySettings {
  const url = resolveJobspyUrl(settings, env);
  const country = settings.country_indeed?.trim() || indeedCountryOf(market) || "";
  return { ...settings, url, country_indeed: country, market };
}

/** Body of `POST /search` (field names are the sidecar's). */
export interface JobspySearchRequest {
  site: JobspySite;
  search_term: string;
  location: string | null;
  hours_old: number;
  results_wanted: number;
  is_remote: boolean;
  /** Only sent when known; the sidecar requires it for Indeed and ignores it for the other sites. */
  country_indeed?: string;
  linkedin_fetch_description: boolean;
  proxies: string[];
}

/** OR-group of keywords in the operator syntax LinkedIn and Indeed understand: `"a" OR "b"`. */
export function searchTermFor(keywords: readonly string[]): string {
  const terms = keywords.map((k) => k.replace(/"/g, " ").replace(/\s+/g, " ").trim()).filter((k) => k !== "");
  return terms.map((t) => `"${t}"`).join(" OR ");
}

/** Where a query searches: the city, or for remote queries the location configured for its `remote_scope`. */
export function locationFor(query: SearchQuery, settings: JobspySettings): string | null {
  if (searchKind(query) === "company") return settings.market.countryName;
  if (!query.remote) return query.location;
  const configured = remoteLocationFor(query.remoteScope ?? "worldwide", settings.remote_location, settings.market, { worldwideText: "", emptyMeansNoLocation: true });
  return configured.trim() === "" ? null : configured.trim();
}

export function buildSearchRequest(site: JobspySite, query: SearchQuery, settings: JobspySettings): JobspySearchRequest {
  const searchTerm = searchTermFor(query.keywords);
  if (searchTerm === "") throw new ChannelError("unknown", "jobspy search needs at least one keyword", { retryable: false });
  if (site === "indeed" && settings.country_indeed === "") {
    throw new ChannelError("unknown", `Indeed does not serve ${settings.market.countryName}: set jobspy.country_indeed`, { retryable: false });
  }
  return {
    site,
    search_term: searchTerm,
    location: locationFor(query, settings),
    hours_old: Math.max(1, Math.ceil(query.windowHours)),
    results_wanted: Math.max(1, query.maxResults),
    is_remote: searchKind(query) === "remote",
    ...(settings.country_indeed === "" ? {} : { country_indeed: settings.country_indeed }),
    linkedin_fetch_description: site === "linkedin" && settings.linkedin_fetch_description,
    proxies: [...settings.proxies],
  };
}

// ---------------------------------------------------------------- responses (C6)

export const jobspyResponseSchema = z.object({
  site: z.enum(JOBSPY_SITES),
  count: z.number().int().nonnegative(),
  jobs: z.array(z.record(z.string(), z.unknown())),
  warnings: z.array(z.string()).default([]),
});
export type JobspyResponse = z.infer<typeof jobspyResponseSchema>;

const SIDECAR_ERROR_CODES = ["rate_limited", "blocked", "upstream_error", "invalid_request"] as const;
export const jobspyErrorSchema = z.object({
  code: z.enum(SIDECAR_ERROR_CODES),
  message: z.string(),
});

/** Longest sidecar message kept in a ChannelError. */
const MAX_MESSAGE_CHARS = 200;

/** Statuses the sidecar answers with a structured error body (so `ctx.http` must not retry or throw on them). */
const SIDECAR_ERROR_STATUSES = [422, 429, 502] as const;

function statusFallbackCode(status: number): (typeof SIDECAR_ERROR_CODES)[number] {
  if (status === 429) return "rate_limited";
  if (status === 422) return "invalid_request";
  return "upstream_error";
}

/**
 * Sidecar error → ChannelError. `rate_limited` and `blocked` feed the circuit breaker as such;
 * `upstream_error` is a failed scrape (`network`, not retried: the upstream just said no);
 * `invalid_request` is our own bug (`unknown`).
 */
export function channelErrorFromSidecar(status: number, body: unknown): ChannelError {
  const parsed = jobspyErrorSchema.safeParse(body);
  const code = parsed.success ? parsed.data.code : statusFallbackCode(status);
  const detail = parsed.success ? `: ${parsed.data.message.slice(0, MAX_MESSAGE_CHARS)}` : "";
  switch (code) {
    case "rate_limited":
      return new ChannelError("rate_limited", `jobspy: rate limited by the job board${detail}`, { status });
    case "blocked":
      return new ChannelError("blocked", `jobspy: blocked by the job board${detail}`, { status });
    case "invalid_request":
      return new ChannelError("unknown", `jobspy sidecar rejected the request${detail}`, { status, retryable: false });
    case "upstream_error":
      return new ChannelError("network", `jobspy: upstream error${detail}`, { status, retryable: false });
  }
}

/** Run one search. Never retried here: a 429 must not be hammered; the cycle's circuit breaker decides. */
export async function searchJobspy(ctx: ChannelContext, settings: JobspySettings, request: JobspySearchRequest): Promise<JobspyResponse> {
  const url = `${settings.url}/search`;
  const response = await ctx.http.request(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(request),
    allowStatus: SIDECAR_ERROR_STATUSES,
    timeoutMs: settings.timeout_ms,
    // The sidecar may keep scraping after a client timeout; repeating the POST starts the whole scrape again.
    maxRetries: 0,
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (response.status >= 400) throw channelErrorFromSidecar(response.status, null);
    throw new ChannelError("parse", "jobspy sidecar response is not valid JSON", { cause: error });
  }
  if (response.status >= 400) throw channelErrorFromSidecar(response.status, body);
  const parsed = jobspyResponseSchema.safeParse(body);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(root)");
    throw new ChannelError("parse", `jobspy sidecar response does not match the expected shape (${paths.join(", ")})`);
  }
  if (parsed.data.site !== request.site) {
    throw new ChannelError("parse", `jobspy sidecar answered for site ${parsed.data.site}, asked for ${request.site}`);
  }
  for (const warning of parsed.data.warnings) ctx.logger.warn("jobspy reported an error alongside results", { site: request.site, warning: warning.slice(0, MAX_MESSAGE_CHARS) });
  return parsed.data;
}

// ---------------------------------------------------------------- raw postings

/** Keys never kept, even if a sidecar version returned them (C5: no e-mail addresses, no phone numbers). */
function isPrivateKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return lowered === "emails" || lowered === "email" || lowered.includes("phone");
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function postedAtOf(value: unknown): Date | null {
  const raw = text(value);
  if (raw === null) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Sidecar jobs → raw postings, verbatim apart from private keys. `externalId` is jobspy's id
 * (`in-…`, `go-…`; LinkedIn's `li-` prefix is removed to match the other LinkedIn channels), falling back to the job URL.
 * Postings with neither are dropped; a repeated id keeps its first occurrence.
 */
export function rawPostingsFromJobs(jobs: readonly Record<string, unknown>[], ctx: Pick<ChannelContext, "logger">, site?: JobspySite): RawPostingInput[] {
  const seen = new Set<string>();
  const out: RawPostingInput[] = [];
  let dropped = 0;
  for (const job of jobs) {
    const payload = Object.fromEntries(Object.entries(job).filter(([key]) => !isPrivateKey(key)));
    const url = text(payload.job_url);
    const id = text(payload.id);
    const externalId = (site === "linkedin" ? id?.replace(/^li-/, "") : id) || url;
    if (externalId === null) {
      dropped += 1;
      continue;
    }
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    out.push({ externalId, url, payload, postedAt: postedAtOf(payload.date_posted) });
  }
  if (dropped > 0) ctx.logger.warn("jobspy postings without id and url dropped", { dropped });
  return out;
}

/** The common `collect`: build the request, call the sidecar, return raw postings. */
export async function collectFromJobspy(
  site: JobspySite,
  query: SearchQuery,
  ctx: ChannelContext,
  settings: JobspySettings,
): Promise<RawPostingInput[]> {
  const request = buildSearchRequest(site, query, settings);
  const response = await searchJobspy(ctx, settings, request);
  return rawPostingsFromJobs(response.jobs, ctx, site).slice(0, query.maxResults);
}

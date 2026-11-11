import type { ArbeitsagenturSettings } from "@/lib/config";
import { lookupPlace, type PlaceGeo } from "@/lib/market/places";

import { ChannelError } from "../errors";
import type { ChannelContext } from "../types";
import {
  detailSchema,
  searchResponseSchema,
  type BaDetail,
  type BaSearchResponse,
} from "./schema";

/** Path of the search endpoint below `base_url` (verified live: v4 answers 403 since the v6 rollout). */
export const SEARCH_PATH = "pc/v6/jobs";
/** Path of the detail endpoint; the id is `base64(refnr)`. */
export const DETAIL_PATH = "pc/v4/jobdetails";
/** The API accepts 1..100 days for `veroeffentlichtseit`; 0 returns nothing. */
export const MIN_PUBLISHED_DAYS = 1;
export const MAX_PUBLISHED_DAYS = 100;
/**
 * Company lookups ask the employer-name parameter `arbeitgeber` first. Live comparison (veroeffentlichtseit=100, size=50):
 * it matches the employer name exactly, so `Siemens AG` gives 334 hits that all come from that employer and `SAP` gives 45
 * (`SAP SE` only 1), but a short form such as `Siemens`, `Deutsche Bahn` or `DB Fernverkehr AG` gives 0. The free-text
 * parameter `was` finds those too and is noisy (`Siemens`: 7779 hits, the first page mostly staffing agencies, 4 of 50 from
 * Siemens AG), so it is the fallback, used only when `arbeitgeber` has no hit, and its results are narrowed afterwards
 * (see `employerMatches` in the channel).
 */
export type CompanyParam = "arbeitgeber" | "was";
export const COMPANY_PARAMS: readonly CompanyParam[] = ["arbeitgeber", "was"];

type ClientSettings = Pick<ArbeitsagenturSettings, "base_url" | "api_key" | "radius_km">;

export interface SearchParams {
  /** Free-text job title search (`was`). */
  term: string;
  /** City (`wo`) with the radius from settings; null searches all of Germany (no `wo`, no radius). */
  location: string | null;
  /** Look-back window; converted to whole days. */
  windowHours: number;
  /** 1-based page number. */
  page: number;
  size: number;
  kind?: "city" | "remote" | "company";
  /** Which parameter carries the term of a company lookup; default `arbeitgeber`. Other kinds always use `was`. */
  companyParam?: CompanyParam;
}

/**
 * The name to search a place under: the API matches German names, so `Germany` and `Munich` find nothing where `Deutschland`
 * and `München` do. A country gets its German name from `Intl`, a city the place dictionary's German name; any other place is
 * searched as written.
 */
export function germanLocation(location: string, geo: PlaceGeo): string {
  const place = lookupPlace(location, geo);
  const code = place?.kind === "country" ? place.countries[0] : undefined;
  if (code !== undefined) return new Intl.DisplayNames(["de"], { type: "region" }).of(code) ?? location;
  return place?.kind === "city" ? (place.geoname?.names.de ?? location) : location;
}

/** `veroeffentlichtseit` for a look-back window: whole days, rounded up, within what the API accepts. */
export function publishedDays(windowHours: number): number {
  return Math.min(MAX_PUBLISHED_DAYS, Math.max(MIN_PUBLISHED_DAYS, Math.ceil(windowHours / 24)));
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path}`;
}

function headers(settings: ClientSettings): Record<string, string> {
  return { "X-API-Key": settings.api_key, Accept: "application/json" };
}

export function searchUrl(settings: ClientSettings, params: SearchParams): string {
  const query = new URLSearchParams({ [params.kind === "company" ? (params.companyParam ?? "arbeitgeber") : "was"]: params.term });
  if (params.kind !== "company" && params.location !== null) {
    query.set("wo", params.location);
    query.set("umkreis", String(settings.radius_km));
  }
  query.set("veroeffentlichtseit", String(publishedDays(params.windowHours)));
  query.set("page", String(params.page));
  query.set("size", String(params.size));
  return `${endpoint(settings.base_url, SEARCH_PATH)}?${query.toString()}`;
}

export function detailUrl(settings: ClientSettings, refnr: string): string {
  return `${endpoint(settings.base_url, DETAIL_PATH)}/${Buffer.from(refnr, "utf8").toString("base64")}`;
}

/** One page of search results. 429 / 5xx are retried by `ctx.http`; other failures arrive classified. */
export async function fetchSearchPage(ctx: ChannelContext, settings: ClientSettings, params: SearchParams): Promise<BaSearchResponse> {
  return ctx.http.json(searchUrl(settings, params), searchResponseSchema, { headers: headers(settings) });
}

/** The detail record of a posting, or null when the posting is gone (404, e.g. filled since the search). */
export async function fetchDetail(ctx: ChannelContext, settings: ClientSettings, refnr: string): Promise<BaDetail | null> {
  const url = detailUrl(settings, refnr);
  const response = await ctx.http.request(url, { headers: headers(settings), allowStatus: [404] });
  if (response.status === 404) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new ChannelError("parse", "job detail response is not valid JSON", { cause: error });
  }
  const parsed = detailSchema.safeParse(body);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(root)");
    throw new ChannelError("parse", `job detail does not match the expected shape (${paths.join(", ")})`);
  }
  return parsed.data;
}

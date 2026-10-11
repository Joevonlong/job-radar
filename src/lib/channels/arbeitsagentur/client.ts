import type { ArbeitsagenturSettings } from "@/lib/config";

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
  const query = new URLSearchParams({ was: params.term });
  if (params.location !== null) {
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

import type { BerlinStartupJobsSettings } from "@/lib/config";

import { issuePaths } from "../ats/envelope";
import { ChannelError } from "../errors";
import type { ChannelContext } from "../types";
import { POST_FIELDS, TERM_FIELDS, termSchema, type BerlinStartupJobsTerm } from "./schema";

/** Paths below `base_url`: the standard WordPress REST routes. Nothing else of the site is ever called. */
export const POSTS_PATH = "wp-json/wp/v2/posts";
export const COMPANY_PATH = "wp-json/wp/v2/job_company";
export const LOCATION_PATH = "wp-json/wp/v2/job_location";

/** Terms asked for per request (WordPress allows at most 100 per page). */
export const TERM_BATCH = 100;

/**
 * Statuses the channel turns into `blocked` itself: 401 (WordPress `rest_cannot_access`; the generic mapping would say the login
 * expired, but the interface needs none), 404 (`rest_no_route`: REST is closed) and 410. All open the circuit.
 */
const CLOSED = [401, 404, 410] as const;

type ClientSettings = Pick<BerlinStartupJobsSettings, "base_url" | "user_agent" | "per_page">;

const root = (settings: Pick<BerlinStartupJobsSettings, "base_url">): string => settings.base_url.replace(/\/+$/, "");
const headers = (settings: Pick<BerlinStartupJobsSettings, "user_agent">): Record<string, string> => ({ "User-Agent": settings.user_agent, Accept: "application/json" });

export function postsUrl(settings: ClientSettings, page: number): string {
  return `${root(settings)}/${POSTS_PATH}?per_page=${settings.per_page}&page=${page}&_fields=${POST_FIELDS.join(",")}`;
}

export function companyUrl(settings: Pick<BerlinStartupJobsSettings, "base_url">, ids: readonly number[]): string {
  return `${root(settings)}/${COMPANY_PATH}?include=${ids.join(",")}&per_page=${TERM_BATCH}&_fields=${TERM_FIELDS.join(",")}`;
}

export function locationUrl(settings: Pick<BerlinStartupJobsSettings, "base_url">): string {
  return `${root(settings)}/${LOCATION_PATH}?per_page=${TERM_BATCH}&_fields=${TERM_FIELDS.join(",")}`;
}

function closed(status: number): ChannelError {
  return new ChannelError("blocked", `REST API closed (HTTP ${status})`, { status, tripsCircuit: true });
}

async function jsonArray(response: { json(): Promise<unknown> }, what: string): Promise<unknown[]> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new ChannelError("parse", `${what} is not valid JSON`, { cause: error });
  }
  if (!Array.isArray(body)) throw new ChannelError("parse", `${what} is not an array`);
  return body as unknown[];
}

export interface PostsPage {
  /** The posts, each still to be checked on its own. */
  posts: unknown[];
  /** `X-WP-TotalPages`; null when the header is missing or not a number. */
  totalPages: number | null;
  /** The page lies beyond the last one (WordPress answers 400, `rest_post_invalid_page_number`): the scan is over. */
  beyondEnd: boolean;
}

/**
 * One page of posts. 429 / 5xx are retried by `ctx.http` (Retry-After honoured). From page 2 on, a 400 means the board got
 * shorter during the scan: the end, not a failure. A response that is not an array is a `parse` error of the page.
 */
export async function fetchPostsPage(ctx: ChannelContext, settings: ClientSettings, page: number): Promise<PostsPage> {
  const allowStatus = page > 1 ? [...CLOSED, 400] : [...CLOSED];
  const response = await ctx.http.request(postsUrl(settings, page), { headers: headers(settings), allowStatus });
  if ((CLOSED as readonly number[]).includes(response.status)) throw closed(response.status);
  if (response.status === 400) {
    await response.cancel?.();
    return { posts: [], totalPages: null, beyondEnd: true };
  }
  const posts = await jsonArray(response, `page ${page}`);
  const header = Number.parseInt(response.headers.get("x-wp-totalpages") ?? "", 10);
  return { posts, totalPages: Number.isInteger(header) && header >= 1 ? header : null, beyondEnd: false };
}

/** Terms of a taxonomy as the response lists them; one that does not match the shape is dropped (a post pointing at it falls back). */
async function termsOf(ctx: ChannelContext, url: string, settings: ClientSettings, what: string): Promise<BerlinStartupJobsTerm[]> {
  const response = await ctx.http.request(url, { headers: headers(settings), allowStatus: [...CLOSED] });
  if ((CLOSED as readonly number[]).includes(response.status)) throw closed(response.status);
  const items = await jsonArray(response, what);
  const terms: BerlinStartupJobsTerm[] = [];
  for (const item of items) {
    const parsed = termSchema.safeParse(item);
    if (parsed.success) terms.push(trimTerm(parsed.data));
  }
  if (items.length > 0 && terms.length === 0) {
    const first = termSchema.safeParse(items[0]);
    throw new ChannelError("parse", `${what} does not match the expected shape (${first.success ? "" : issuePaths(first.error)})`);
  }
  return terms;
}

/** The term as stored: the four whitelisted keys only, so nothing that changes between runs (counts, links to the API) enters the payload. */
export function trimTerm(term: BerlinStartupJobsTerm): BerlinStartupJobsTerm {
  return { id: term.id, name: term.name, slug: term.slug, ...(term.link === undefined ? {} : { link: term.link }) };
}

/** The company terms of `ids`, in batches of `TERM_BATCH`, one request each (`ctx.throttle()` between them). */
export async function fetchCompanies(ctx: ChannelContext, settings: ClientSettings, ids: readonly number[]): Promise<BerlinStartupJobsTerm[]> {
  const found: BerlinStartupJobsTerm[] = [];
  for (let at = 0; at < ids.length; at += TERM_BATCH) {
    ctx.signal.throwIfAborted();
    if (at > 0) await ctx.throttle();
    found.push(...(await termsOf(ctx, companyUrl(settings, ids.slice(at, at + TERM_BATCH)), settings, `company terms ${at / TERM_BATCH + 1}`)));
  }
  return found;
}

/** All location terms (a handful), one request. */
export function fetchLocations(ctx: ChannelContext, settings: ClientSettings): Promise<BerlinStartupJobsTerm[]> {
  return termsOf(ctx, locationUrl(settings), settings, "location terms");
}

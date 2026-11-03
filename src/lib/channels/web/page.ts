import { ChannelError, looksBlocked } from "../errors";
import type { ChannelContext, HttpResponse } from "../types";

/** Fetching HTML pages of the job boards: politeness headers, "gone" pages, bot-detection pages. */

export interface PageRequest {
  url: string;
  userAgent: string;
  /**
   * When set, redirects are not followed blindly: each hop's target must pass this check (a site whose robots.txt limits which URLs may be
   * requested), or the request fails without asking for it. Without it redirects are followed as `fetch` does.
   */
  allowRedirectTo?: (target: URL) => boolean;
}

const REDIRECT_STATUSES = [301, 302, 303, 307, 308] as const;
const MAX_REDIRECT_HOPS = 5;

/** Statuses that mean "this posting is not there (any more)", not a failure. */
const GONE_STATUSES = [404, 410] as const;

function headers(userAgent: string): Record<string, string> {
  return {
    "User-Agent": userAgent,
    Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
    "Accept-Language": "de-DE,de;q=0.9,en;q=0.5",
  };
}

/**
 * The page's HTML, or null when the page is gone (404 / 410). 429 / 5xx are retried by `ctx.http`;
 * 403 and verification pages arrive as `blocked` and must end the query: do not try again.
 */
export async function fetchHtml(ctx: ChannelContext, request: PageRequest): Promise<string | null> {
  const response = await requestChecked(ctx, request);
  if (GONE_STATUSES.some((status) => status === response.status)) return null;
  try {
    return await response.text();
  } catch (error) {
    throw new ChannelError("network", `reading the response of ${new URL(request.url).host} failed`, { cause: error });
  }
}

async function requestChecked(ctx: ChannelContext, request: PageRequest): Promise<HttpResponse> {
  const { allowRedirectTo } = request;
  if (allowRedirectTo === undefined) return ctx.http.request(request.url, { headers: headers(request.userAgent), allowStatus: GONE_STATUSES });
  let url = request.url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    const response = await ctx.http.request(url, {
      headers: headers(request.userAgent),
      allowStatus: [...GONE_STATUSES, ...REDIRECT_STATUSES],
      redirect: "manual",
    });
    if (!REDIRECT_STATUSES.some((status) => status === response.status)) return response;
    const location = response.headers.get("location");
    await response.cancel?.();
    let target: URL | null = null;
    try {
      target = location === null ? null : new URL(location, url);
    } catch {
      target = null;
    }
    const host = new URL(url).host;
    if (target === null || !allowRedirectTo(target)) {
      throw new ChannelError("unknown", `${host}: redirected to a URL the site's robots.txt does not permit, not followed`, { retryable: false });
    }
    url = target.toString();
  }
  throw new ChannelError("unknown", `${new URL(request.url).host}: too many redirects`, { retryable: false });
}

/**
 * Error for a page that lacks the data the channel reads: a bot-detection / login page (`blocked`,
 * not retried) when it looks like one, otherwise a changed page layout (`parse`). Call it only when
 * the data is missing: real pages mention "captcha" in their scripts.
 */
export function missingDataError(html: string, host: string, what: string): ChannelError {
  if (looksBlocked(html)) return new ChannelError("blocked", `${host}: ${what} is missing and the page looks like a verification page`);
  return new ChannelError("parse", `${host}: ${what} is missing from the page (layout changed?)`);
}

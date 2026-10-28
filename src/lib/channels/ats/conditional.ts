import { ChannelError, isAbortError } from "@/lib/channels/errors";
import type { ChannelContext } from "@/lib/channels/types";

/** Conditional board requests (ported from legacy `http-conditional.ts`): ETag / If-None-Match over `ctx.http`. */

const USER_AGENT = "JobRadar/0.1 (personal job search)";

/**
 * A conditional list read. Content keeps every page read before an interruption; `incomplete`
 * and `shortfall` are mutually exclusive. Only a complete list may supply a reusable ETag.
 */
export type BoardFetch =
  /** 304: the board has not changed since the request's validator. Says nothing about its postings. */
  | { kind: "not_modified" }
  /** 404: the board does not exist (any more) — a configuration problem, not an empty board. */
  | { kind: "not_found" }
  | {
      kind: "content";
      body: unknown;
      /** Validator to send next time; null when the response was partial or carried none. */
      etag: string | null;
      /** True exactly when neither `incomplete` nor `shortfall` is present. */
      complete: boolean;
      /** A list request failed; soft for a later-page 404 or a non-200 2xx response. */
      incomplete?: { cause: ChannelError; soft: boolean };
      /** Every page answered, but fewer distinct postings were listed than announced. */
      shortfall?: { listed: number; announced: number };
    };

export function conditionalHeaders(etag: string | null, accept = "application/json"): Record<string, string> {
  return {
    Accept: accept,
    "User-Agent": USER_AGENT,
    // `fetch` adds `Cache-Control: no-cache` to every conditional request that has no Cache-Control of its
    // own, and some APIs (SmartRecruiters) then never answer 304. `max-age=0` still asks for revalidation.
    ...(etag ? { "If-None-Match": etag, "Cache-Control": "max-age=0" } : {}),
  };
}

/** How a board response body is turned into the value `AtsAdapter.list` receives. */
export interface BoardFormat {
  /** `Accept` header. */
  accept: string;
  /** Decodes the response text; throws on malformed input (reported as `ChannelError("parse")`). */
  decode(text: string): unknown;
}

const JSON_FORMAT: BoardFormat = { accept: "application/json", decode: (text) => JSON.parse(text) as unknown };

/** GET a board, sending `If-None-Match` when `etag` is given. Other failures throw a classified `ChannelError`. */
export async function fetchBoard(ctx: ChannelContext, url: string, etag: string | null, format: BoardFormat): Promise<BoardFetch> {
  const response = await ctx.http.request(url, { headers: conditionalHeaders(etag, format.accept), allowStatus: [304, 404] });
  if (response.status === 304 || response.status === 404) await response.cancel?.();
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 304) {
    if (etag === null) throw new ChannelError("unknown", "HTTP 304 without a conditional request", { status: 304 });
    return { kind: "not_modified" };
  }
  let body: unknown;
  try {
    body = format.decode(await response.text());
  } catch (error) {
    // Preserve classified body-stream failures and let cancellation propagate.
    if (error instanceof ChannelError || isAbortError(error) || ctx.signal.aborted) throw error;
    throw new ChannelError("parse", `response from ${new URL(url).host} could not be decoded`, { cause: error });
  }
  const complete = response.status === 200;
  const header = response.headers.get("etag");
  return {
    kind: "content",
    body,
    etag: complete && header !== null && header.trim() !== "" ? header : null,
    complete,
    ...(!complete ? {
      incomplete: {
        cause: new ChannelError("unknown", `partial response (HTTP ${response.status})`, { status: response.status }),
        soft: true,
      },
    } : {}),
  };
}

/** GET a board's JSON, sending `If-None-Match` when `etag` is given. */
export async function fetchBoardJson(ctx: ChannelContext, url: string, etag: string | null): Promise<BoardFetch> {
  return fetchBoard(ctx, url, etag, JSON_FORMAT);
}

import { ChannelError } from "@/lib/channels/errors";
import type { HttpClient, HttpResponse } from "@/lib/channels/types";
import { publicUrlGuard, requestPublicUrl, type HostResolver, type UrlGuard } from "@/lib/net/public-url";

export type LinkStatus = "alive" | "gone" | "unknown";

/** Statuses that mean the posting was taken down; anything else (403, 429, 5xx ...) proves nothing. */
const GONE_STATUSES: readonly number[] = [404, 410];
/** Bytes of a GET body read before it is cancelled (the status is the answer; the page itself is not needed). */
const BODY_DRAIN_BYTES = 1024;

export interface LinkCheckOptions {
  /** Resolves host names for the public-address check (default: the system resolver). Tests inject one. */
  resolve?: HostResolver;
  /** Replaces the whole public-address check (tests against a local server); wins over `resolve`. */
  guard?: UrlGuard;
  /** Called when the URL (or a redirect hop) was not requested because it is not a public http(s) address. */
  onBlocked?: () => void;
  /** The User-Agent of both requests (`lifecycle.watch_recheck.user_agent`); absent = the runtime's default. */
  userAgent?: string;
  /** Timeout of each request (`pipeline.yaml: lifecycle.link_check_timeout_ms`); absent = the HTTP client's own. */
  timeoutMs?: number;
}

/** One request through `requestPublicUrl` (redirects by hand, every hop checked): the last answer, or null when a hop was refused. */
async function requestChecked(http: HttpClient, url: string, method: "HEAD" | "GET", guard: UrlGuard, headers: Record<string, string> | undefined, timeoutMs: number | undefined): Promise<HttpResponse | null> {
  const result = await requestPublicUrl(http, url, { method, guard, ...(headers ? { headers } : {}), ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  return result.kind === "response" ? result.response : null;
}

/**
 * Is the posting behind `url` still online? HEAD first; if that does not come back 2xx / 3xx the
 * answer is confirmed with a GET (some servers mishandle HEAD). Only 404 / 410 on the GET counts as
 * `gone`; a network error, timeout, 403, 429 or 5xx is `unknown`. Cancellation propagates. Both requests carry the
 * configured User-Agent when one is given.
 *
 * The URL comes from third-party data, so it is only requested when it is a public http(s) address, and the same is
 * checked for every redirect hop (no `localhost`, Docker service names, private or link-local addresses): anything
 * else is `unknown` and nothing is sent.
 */
export async function checkLink(http: HttpClient, url: string, options: LinkCheckOptions = {}): Promise<LinkStatus> {
  const guard = options.guard ?? publicUrlGuard(options.resolve);
  const headers = options.userAgent ? { "user-agent": options.userAgent } : undefined;
  try {
    const head = await requestChecked(http, url, "HEAD", guard, headers, options.timeoutMs);
    if (head === null) {
      options.onBlocked?.();
      return "unknown";
    }
    if (head.status < 400) return "alive";
  } catch (error) {
    if (!(error instanceof ChannelError)) throw error;
  }
  try {
    const get = await requestChecked(http, url, "GET", guard, headers, options.timeoutMs);
    if (get === null) {
      options.onBlocked?.();
      return "unknown";
    }
    // The body is not needed: a first piece is read (at most BODY_DRAIN_BYTES, the rest is never downloaded) to release the connection
    // and the request timeout.
    await (get.textUpTo ? get.textUpTo(BODY_DRAIN_BYTES) : get.text()).catch(() => undefined);
    if (get.status < 400) return "alive";
    return GONE_STATUSES.includes(get.status) ? "gone" : "unknown";
  } catch (error) {
    if (!(error instanceof ChannelError)) throw error;
    return "unknown";
  }
}

/** Combine the checks of a job's links: any live link keeps it online; all gone closes it. */
export function combineLinkStatuses(statuses: readonly LinkStatus[]): LinkStatus {
  if (statuses.includes("alive")) return "alive";
  if (statuses.length > 0 && statuses.every((s) => s === "gone")) return "gone";
  return "unknown";
}

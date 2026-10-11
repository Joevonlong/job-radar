import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { HttpClient, HttpRequestInit, HttpResponse } from "@/lib/channels/types";

/**
 * Guards for fetching a URL that came from DATA (a job posting's apply link from an e-mail alert, JSearch, a scraper), not from
 * the user's configuration: the request must go to the public internet, never to this machine, the Docker network or the LAN
 * (blind SSRF: a forged posting could otherwise make the runner call `http://jobspy:8000/...`, `http://host.docker.internal:...`
 * or a cloud metadata address).
 */

/** Resolve a host name to its addresses (default: the system resolver, every address). */
export type HostResolver = (host: string) => Promise<readonly string[]>;

export const systemResolver: HostResolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

export type UrlRefusal = "scheme" | "credentials" | "host" | "address" | "unresolved";

function ipv4Parts(address: string): number[] | null {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255) ? parts : null;
}

/** The eight 16-bit groups of an IPv6 address (`::` expanded, a trailing dotted IPv4 part converted); null when it is not one. */
function ipv6Hextets(value: string): number[] | null {
  let text = value;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    const parts = ipv4Parts(dotted[1]);
    if (!parts) return null;
    text = `${text.slice(0, dotted.index)}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

/** True for loopback, private (RFC 1918), link-local, CGNAT, "this network", multicast and reserved addresses, IPv4 and IPv6. */
export function isNonPublicAddress(address: string): boolean {
  let value = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);
  const family = isIP(value);
  if (family === 4) {
    const [a, b] = ipv4Parts(value) ?? [0, 0];
    return (
      a === 0 || // 0.0.0.0/8
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) || // 192.0.0.0/24 and 192.0.2.0/24 documentation
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      a >= 224 // multicast, reserved, broadcast
    );
  }
  if (family === 6) {
    const h = ipv6Hextets(value);
    if (h === null) return true;
    const v4 = (hi: number, lo: number) => isNonPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    const zeros = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
    if (zeros(0, 8)) return true; // ::
    if (zeros(0, 7) && h[7] === 1) return true; // ::1
    // IPv4 inside IPv6: mapped ::ffff:a.b.c.d, translated ::ffff:0:a.b.c.d, compatible ::a.b.c.d, 6to4 2002:aabb:ccdd::
    if (zeros(0, 5) && h[5] === 0xffff) return v4(h[6]!, h[7]!);
    if (zeros(0, 4) && h[4] === 0xffff && h[5] === 0) return v4(h[6]!, h[7]!);
    if (zeros(0, 6)) return v4(h[6]!, h[7]!);
    if (h[0] === 0x2002) return v4(h[1]!, h[2]!);
    const first = h[0]!;
    return (
      (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
      (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
      (first & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
      (first & 0xff00) === 0xff00 || // multicast
      (first === 0x64 && h[1] === 0xff9b) || // 64:ff9b::/96 NAT64 and 64:ff9b:1::/48 local NAT64
      (first === 0x2001 && h[1] === 0) || // 2001::/32 Teredo (embeds an IPv4 address)
      (first === 0x2001 && h[1] === 0xdb8) || // documentation
      (first === 0x100 && zeros(1, 4)) // 100::/64 discard
    );
  }
  return true; // not an address at all: never treated as public
}

/** Host names that are never public: this machine, the Docker host alias, mDNS / internal suffixes. */
function isInternalName(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "host.docker.internal" || host === "gateway.docker.internal") return true;
  // A name without a dot is a compose service (`jobspy`, `db`) or a LAN host, never a public site.
  if (isIP(host) === 0 && !host.includes(".")) return true;
  return /\.(local|internal|lan|home|intranet|corp|localdomain)$/.test(host);
}

/**
 * Why `rawUrl` may not be fetched, or null when it may: http(s) only, no credentials in the URL, no internal host name, and
 * every address the name resolves to is public. A DNS failure is a refusal too (nothing is requested).
 */
export async function publicUrlProblem(rawUrl: string, resolve: HostResolver = systemResolver): Promise<UrlRefusal | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "host";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "scheme";
  if (url.username !== "" || url.password !== "") return "credentials";
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "" || isInternalName(host)) return "host";
  if (isIP(host) !== 0) return isNonPublicAddress(host) ? "address" : null;
  let addresses: readonly string[];
  try {
    addresses = await resolve(host);
  } catch {
    return "unresolved";
  }
  if (addresses.length === 0) return "unresolved";
  return addresses.some(isNonPublicAddress) ? "address" : null;
}

/** Decides whether one URL (the first or a redirect hop) may be requested: null = yes, else why not. */
export type UrlGuard = (url: string) => Promise<UrlRefusal | null>;

/** The default guard: `publicUrlProblem` with `resolve` (tests inject a resolver, or a whole guard for a local test server). */
export function publicUrlGuard(resolve: HostResolver = systemResolver): UrlGuard {
  return (url) => publicUrlProblem(url, resolve);
}

/** Redirect statuses followed by `requestPublicUrl` (by hand, one hop at a time). */
export const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308];
/** Longest redirect chain followed; each hop is checked like the first URL. */
export const MAX_REDIRECTS = 5;
/** Redirect bodies are drained up to this many bytes (releases the connection; nothing is kept). */
const REDIRECT_BODY_BYTES = 1024;

export interface PublicRequestOptions<Stop> extends Omit<HttpRequestInit, "redirect"> {
  /** Checks every hop (default: `publicUrlGuard()`, the system resolver). */
  guard?: UrlGuard;
  /**
   * Called for every hop that passed the guard, right before it is requested (robots.txt and the per-host gap of the recheck): a
   * non-null answer stops the chain without requesting that hop.
   */
  beforeHop?: (url: string) => Promise<Stop | null>;
}

export type PublicRequestResult<Stop> =
  /** The answer of the last hop (not a redirect, or a redirect without a usable Location); `url` is that hop. */
  | { kind: "response"; response: HttpResponse; url: string }
  /** A hop is not a public http(s) address, a Location is invalid, or the chain is longer than MAX_REDIRECTS: nothing more was sent. */
  | { kind: "refused"; url: string; reason: UrlRefusal | "redirects" }
  /** `beforeHop` stopped the chain at `url`. */
  | { kind: "stopped"; url: string; stop: Stop };

/**
 * A request to a URL that came from data: redirects are handed back (`redirect: "manual"`) and followed by hand, at most
 * MAX_REDIRECTS of them, and every hop is checked by the guard before anything is sent to it. 4xx / 5xx answers come back as
 * responses (no ChannelError); network errors and timeouts propagate as ChannelError, cancellation as the abort reason.
 */
export async function requestPublicUrl<Stop = never>(http: HttpClient, start: string, options: PublicRequestOptions<Stop> = {}): Promise<PublicRequestResult<Stop>> {
  const { guard = publicUrlGuard(), beforeHop, allowStatus = [], ...init } = options;
  const allow = [...new Set([...allowStatus, ...REDIRECT_STATUSES, ...Array.from({ length: 200 }, (_, i) => 400 + i)])];
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const refusal = await guard(url);
    if (refusal !== null) return { kind: "refused", url, reason: refusal };
    if (beforeHop) {
      const stop = await beforeHop(url);
      if (stop !== null) return { kind: "stopped", url, stop };
    }
    const response = await http.request(url, { ...init, redirect: "manual", allowStatus: allow, maxRetries: init.maxRetries ?? 0 });
    if (!REDIRECT_STATUSES.includes(response.status)) return { kind: "response", response, url };
    const location = response.headers.get("location");
    if (location === null || location === "") return { kind: "response", response, url };
    await (response.textUpTo ? response.textUpTo(REDIRECT_BODY_BYTES) : response.text()).catch(() => undefined);
    try {
      url = new URL(location, url).toString();
    } catch {
      return { kind: "refused", url, reason: "host" };
    }
  }
  return { kind: "refused", url, reason: "redirects" };
}

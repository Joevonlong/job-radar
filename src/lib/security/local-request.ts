/**
 * Is a request from this machine? The proxy has no peer address (Next hands it the request headers only, and inside
 * Docker the peer is always the bridge gateway), so the answer comes from the request headers:
 *
 * - `Host` and, when present, every `X-Forwarded-Host` entry name a loopback address;
 * - every `X-Forwarded-For` entry is a loopback address, or, when `JOB_RADAR_WEB_BIND` is set (compose always sets it),
 *   a loopback or private one (the Docker gateway such as 172.18.0.1). Next fills in `X-Forwarded-For` (the socket's
 *   peer), `X-Forwarded-Host`, `-Port` and `-Proto` only when a request arrives without them; a proxy in front puts the
 *   client's address there instead (`tailscale serve`: a 100.x tailnet address);
 * - `X-Forwarded-Proto`, when present, is `http` (`https` means TLS ended in a proxy);
 * - none of the headers only a proxy adds is present (`PROXY_HEADERS`).
 *
 * `tailscale serve` sends a `*.ts.net` host, its tailnet client address and `https`, so its requests are never local.
 *
 * Every one of these headers can be sent by the client itself, and Next keeps a client-supplied `X-Forwarded-For`
 * as it is. So the headers only mean "this machine" when nobody else can connect at all: the local exemption
 * (`localExemptionEnabled`) is on only when `JOB_RADAR_WEB_BIND` says the web listens on a loopback address. Compose
 * always sets it (default 127.0.0.1, the address the port is published on), and `pnpm start` / `pnpm dev`
 * (`scripts/web-run.ts`) set it to the address Next actually listens on. Absent or empty (a hand-run `next start`, the
 * image run without compose) the listen address is unknown and every request needs the password.
 *
 * Pure and dependency-free (unit-tested; `src/proxy.ts` and the root layout call it).
 */
import { splitHostPort } from "./host-allowlist";

/** Host names that mean "this machine". */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Headers only a reverse proxy, a tunnel or a CDN adds (never Next itself): any of them makes a request non-local. Lower
 * case. The `X-Forwarded-*` headers are judged by their values instead (see above).
 */
export const PROXY_HEADERS: readonly string[] = [
  "x-real-ip",
  "forwarded",
  "via",
  "tailscale-user-login",
  "tailscale-user-name",
  "cf-connecting-ip",
  "true-client-ip",
];

/**
 * The address the web is reachable on (`JOB_RADAR_WEB_BIND`): compose publishes the port there and passes it to the
 * container; `pnpm start` / `pnpm dev` make Next listen there and pass the address they used.
 */
export const WEB_BIND_ENV = "JOB_RADAR_WEB_BIND";
/** Set to `1`: local requests need the password too (a proxy that rewrites the Host header). */
export const LOCAL_LOGIN_ENV = "JOB_RADAR_WEB_LOCAL_LOGIN";

/** Header lookup (case-insensitive by contract: `Headers.get` already is). */
export interface HeaderSource {
  get(name: string): string | null;
}

function isLoopbackHost(value: string): boolean {
  const split = splitHostPort(value);
  return split !== null && LOOPBACK_HOSTS.has(split.host);
}

function ipv4Parts(value: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (match === null) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part <= 255) ? parts : null;
}

/** Loopback or private IPv4: 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 (not 100.64/10: tailnet clients). */
function isPrivateIpv4(value: string): boolean {
  const parts = ipv4Parts(value);
  if (parts === null) return false;
  const [a = -1, b = -1] = parts;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function normalizeAddress(entry: string): string {
  let value = entry.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  return value.replace(/%[\w.-]+$/, "");
}

const MAPPED_IPV4 = /^(?:::|(?:0{1,4}:){5})ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;

function isLoopbackIpv4(value: string): boolean {
  const parts = ipv4Parts(value);
  return parts !== null && parts[0] === 127;
}

/** Whether an `X-Forwarded-For` entry is a loopback address: 127/8, `::1`, or `::ffff:127.x.x.x`. Anything unreadable is not. */
export function isLoopbackAddress(entry: string): boolean {
  const value = normalizeAddress(entry);
  if (isLoopbackIpv4(value)) return true;
  if (value === "::1" || value === "0:0:0:0:0:0:0:1") return true;
  const mapped = MAPPED_IPV4.exec(value);
  return mapped?.[1] !== undefined && isLoopbackIpv4(mapped[1]);
}

/**
 * Whether an `X-Forwarded-For` entry is a loopback or private address: IPv4 as above, IPv6 `::1`, unique local `fc00::/7`
 * (but not Tailscale's `fd7a:115c:a1e0::/48`), link-local `fe80::/10`, and IPv4-mapped forms of the IPv4 ones. Anything
 * unreadable is not.
 */
export function isPrivateAddress(entry: string): boolean {
  const value = normalizeAddress(entry);
  if (isPrivateIpv4(value)) return true;
  if (!/^[0-9a-f:.]+$/.test(value) || !value.includes(":")) return false;
  if (value === "::1" || value === "0:0:0:0:0:0:0:1") return true;
  const mapped = MAPPED_IPV4.exec(value);
  if (mapped?.[1] !== undefined) return isPrivateIpv4(mapped[1]);
  // fd7a:115c:a1e0::/48 is Tailscale's IPv6 range (inside fc00::/7): a tailnet client, never this machine
  if (/^fd7a:115c:a1e0:/.test(value)) return false;
  return /^f[cd][0-9a-f]{2}:/.test(value) || /^fe[89ab][0-9a-f]:/.test(value);
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Whether the request names this machine and carries no trace of a proxy in front of the web. Private `X-Forwarded-For`
 * peers (the Docker gateway) only count when `JOB_RADAR_WEB_BIND` is set in `env`; when it is absent or empty only loopback
 * ones do.
 */
export function isLocalRequest(headers: HeaderSource, env: Env = process.env): boolean {
  const peerAllowed = (env[WEB_BIND_ENV] ?? "").trim() === "" ? isLoopbackAddress : isPrivateAddress;
  const host = headers.get("host");
  if (host === null || !isLoopbackHost(host)) return false;
  const forwardedHost = headers.get("x-forwarded-host");
  if (forwardedHost !== null && forwardedHost.trim() !== "") {
    if (!forwardedHost.split(",").every((part) => isLoopbackHost(part))) return false;
  }
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor !== null && !forwardedFor.split(",").every((part) => peerAllowed(part))) return false;
  const forwardedProto = headers.get("x-forwarded-proto");
  if (forwardedProto !== null && !forwardedProto.split(",").every((part) => part.trim().toLowerCase() === "http")) return false;
  return PROXY_HEADERS.every((name) => headers.get(name) === null);
}

/**
 * Whether the bind address is loopback. Empty (compose's default, 127.0.0.1) and any 127.x.x.x / `localhost` / `::1` are;
 * anything else (0.0.0.0, a LAN address, something unreadable) is not: the safe answer when in doubt. For `.env` as the
 * doctor reads it; the running web uses `webListensOnLoopback`, where empty means unknown.
 */
export function isLoopbackBind(value: string | undefined | null): boolean {
  const text = (value ?? "").trim().toLowerCase();
  if (text === "" || text === "localhost" || text === "::1" || text === "[::1]") return true;
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  return match !== null && match.slice(1).every((part) => Number(part) <= 255);
}

/**
 * Whether the running web is known to be reachable on loopback only: `JOB_RADAR_WEB_BIND` is set (compose, `pnpm start`,
 * `pnpm dev`) and names a loopback address. Absent or empty: unknown, so no.
 */
export function webListensOnLoopback(env: Env): boolean {
  const bind = (env[WEB_BIND_ENV] ?? "").trim();
  return bind !== "" && isLoopbackBind(bind);
}

/** Whether a local request may skip the login: only with a known loopback bind and without `JOB_RADAR_WEB_LOCAL_LOGIN=1`. */
export function localExemptionEnabled(env: Env): boolean {
  return webListensOnLoopback(env) && (env[LOCAL_LOGIN_ENV] ?? "").trim() !== "1";
}

/** A local request that may skip the login. */
export function localExemption(headers: HeaderSource, env: Env): boolean {
  return localExemptionEnabled(env) && isLocalRequest(headers, env);
}

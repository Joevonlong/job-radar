/**
 * Which host names may reach the web (protection against DNS rebinding): a page of another site whose name was re-pointed
 * at 127.0.0.1 talks to the dashboard "same-origin" unless the dashboard refuses requests addressed to foreign names.
 *
 * Pure and dependency-free: `src/proxy.ts` checks every request with it, and `next.config.ts` derives the Server Actions
 * origin list from the same entries.
 *
 * An entry is a host name (`jobs.example.com`), optionally with a port (`jobs.example.com:8443`, then only that port
 * matches), or a wildcard `*.example.com` (any name below example.com, at any depth, not example.com itself; the suffix
 * needs at least two labels, so `*.com` is refused). IPv6 addresses are written in brackets (`[::1]`). Matching ignores
 * case and a trailing dot.
 */

/** Environment variable with extra allowed host names, comma-separated (reverse proxies, custom names). */
export const ALLOWED_HOSTS_ENV = "JOB_RADAR_ALLOWED_HOSTS";

/** Always allowed: the loopback names (any port) and Tailscale names (`tailscale serve`, MagicDNS). */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]", "*.ts.net"];

export interface HostEntry {
  /** Lower case, without a trailing dot. For a wildcard: the suffix after `*.`. */
  host: string;
  wildcard: boolean;
  /** null: any port. */
  port: string | null;
}

interface HostAndPort {
  host: string;
  port: string | null;
}

/** `Host`-style text (`name`, `name:port`, `[v6]`, `[v6]:port`) split into host and port; null when it is not one. */
export function splitHostPort(value: string): HostAndPort | null {
  const text = value.trim().toLowerCase();
  if (text === "" || /[\s/\\@?#]/.test(text)) return null;
  let host: string;
  let port: string | null = null;
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close < 0) return null;
    host = text.slice(0, close + 1);
    const rest = text.slice(close + 1);
    if (rest !== "") {
      if (!/^:\d{1,5}$/.test(rest)) return null;
      port = rest.slice(1);
    }
  } else {
    const parts = text.split(":");
    if (parts.length > 2) return null;
    host = parts[0] ?? "";
    if (parts.length === 2) {
      if (!/^\d{1,5}$/.test(parts[1] ?? "")) return null;
      port = parts[1] ?? null;
    }
  }
  host = host.replace(/\.$/, "");
  if (host === "" || host === "[]") return null;
  return { host, port };
}

/** One allowlist entry; a scheme and a path are tolerated (`https://jobs.example.com/` -> `jobs.example.com`). Null when invalid. */
export function parseHostEntry(raw: string): HostEntry | null {
  let text = raw.trim();
  if (text === "") return null;
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/.*$/, "");
  const wildcard = text.startsWith("*.");
  const split = splitHostPort(wildcard ? text.slice(2) : text);
  if (split === null || (wildcard && split.host.startsWith("["))) return null;
  // `*.com` / `*.net` would allow half the internet
  if (wildcard && split.host.split(".").filter((label) => label !== "").length < 2) return null;
  return { host: split.host, wildcard, port: split.port };
}

/** The entries of a comma-separated list (invalid ones are dropped). */
export function parseHostList(value: string | undefined | null): HostEntry[] {
  if (value === undefined || value === null) return [];
  return value
    .split(",")
    .map(parseHostEntry)
    .filter((entry): entry is HostEntry => entry !== null);
}

export interface Allowlist {
  /** Every allowed host: the defaults plus the configured entries. */
  hosts: HostEntry[];
  /** Only the entries of `JOB_RADAR_ALLOWED_HOSTS`: the origins a state-changing request may come from besides its own host. */
  explicit: HostEntry[];
}

/** The full allowlist: the defaults and `JOB_RADAR_ALLOWED_HOSTS`. */
export function buildAllowlist(env?: string | undefined | null): Allowlist {
  const defaults = DEFAULT_ALLOWED_HOSTS.map(parseHostEntry).filter((entry): entry is HostEntry => entry !== null);
  const explicit = parseHostList(env);
  return { hosts: [...defaults, ...explicit], explicit };
}

function entryMatches(entry: HostEntry, target: HostAndPort): boolean {
  if (entry.port !== null && entry.port !== target.port) return false;
  if (entry.wildcard) return target.host.endsWith(`.${entry.host}`);
  return target.host === entry.host;
}

/** Whether a `Host`-style value (`name[:port]`) is on the allowlist. */
export function isAllowedHost(value: string, allowlist: readonly HostEntry[]): boolean {
  const target = splitHostPort(value);
  return target !== null && allowlist.some((entry) => entryMatches(entry, target));
}

export interface RequestHosts {
  method: string;
  host: string | null;
  forwardedHost: string | null;
  origin: string | null;
}

export type HostCheck = { ok: true } | { ok: false; header: "host" | "x-forwarded-host" | "origin"; value: string };

function sameHost(a: string, b: string): boolean {
  const left = splitHostPort(a);
  const right = splitHostPort(b);
  return left !== null && right !== null && left.host === right.host && left.port === right.port;
}

/**
 * Check one request: `Host` must be present and allowed; `X-Forwarded-Host` (when present; Next compares Server Action
 * origins against it) and `Origin` (when present) must be allowed too. A state-changing request (anything but GET / HEAD)
 * must come from the very host it is addressed to (the first `X-Forwarded-Host` entry, else `Host`): another allowed
 * host, such as another `*.ts.net` machine or another local port, is a different site. Only origins listed explicitly in
 * `JOB_RADAR_ALLOWED_HOSTS` are accepted besides it (a proxy that rewrites the host). `Origin: null` is refused for those
 * requests.
 */
export function checkRequestHosts(request: RequestHosts, allowlist: Allowlist): HostCheck {
  const host = request.host ?? "";
  if (!isAllowedHost(host, allowlist.hosts)) return { ok: false, header: "host", value: host };
  if (request.forwardedHost !== null && request.forwardedHost.trim() !== "") {
    // a proxy chain may list several hosts; every one must be allowed
    for (const part of request.forwardedHost.split(",")) {
      if (!isAllowedHost(part, allowlist.hosts)) return { ok: false, header: "x-forwarded-host", value: request.forwardedHost };
    }
  }
  const origin = request.origin?.trim() ?? "";
  if (origin === "") return { ok: true };
  const method = request.method.toUpperCase();
  const safe = method === "GET" || method === "HEAD";
  if (origin === "null") return safe ? { ok: true } : { ok: false, header: "origin", value: origin };
  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = null;
  }
  if (originHost === null || originHost === "" || !isAllowedHost(originHost, allowlist.hosts)) return { ok: false, header: "origin", value: origin };
  if (safe) return { ok: true };
  const target = request.forwardedHost?.split(",")[0]?.trim() || host;
  if (sameHost(originHost, target) || isAllowedHost(originHost, allowlist.explicit)) return { ok: true };
  return { ok: false, header: "origin", value: origin };
}

/** The plain-text body of a refusal: what was refused and how to allow it. Never longer than one short paragraph. */
export function refusalMessage(check: Extract<HostCheck, { ok: false }>): string {
  // printable ASCII only, cut short: the value comes from the request
  const shown = check.value.replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
  return [
    `Job Radar refused this request: the ${check.header === "origin" ? "Origin" : check.header === "host" ? "Host" : "X-Forwarded-Host"} "${shown}" is not an allowed host name.`,
    `Allowed by default: localhost, 127.0.0.1, [::1] and *.ts.net; a form or action must come from the same address it is sent to.`,
    `To reach Job Radar under another name (a reverse proxy, a LAN name), add it to ${ALLOWED_HOSTS_ENV} (comma-separated) in .env and restart the web.`,
    "",
  ].join("\n");
}

/**
 * Entries for Next's `experimental.serverActions.allowedOrigins` (host[:port], `**` for any depth of sub-domains). Next
 * accepts a Server Action whose Origin equals the request's own host anyway; this list only matters behind a proxy that
 * forwards its own host instead of the public one, so it holds only the explicit `JOB_RADAR_ALLOWED_HOSTS` entries (never
 * the defaults: another `*.ts.net` machine is another site).
 */
export function serverActionOrigins(env: string | undefined | null): string[] {
  const out = new Set<string>();
  for (const entry of parseHostList(env)) {
    const host = entry.wildcard ? `**.${entry.host}` : entry.host;
    out.add(entry.port === null ? host : `${host}:${entry.port}`);
  }
  return [...out];
}

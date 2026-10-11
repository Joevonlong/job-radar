/**
 * The web's host allowlist as configured: the defaults plus `JOB_RADAR_ALLOWED_HOSTS`. Server / Node only. Deliberately
 * not derived from any config file the web can write: whoever reaches the web must not be able to widen it.
 */
import { ALLOWED_HOSTS_ENV, buildAllowlist, type Allowlist } from "./host-allowlist";

let cache: { env: string; allowlist: Allowlist } | null = null;

/** The current allowlist (re-parsed only when the variable changes). Never throws. */
export function currentAllowlist(env: Readonly<Record<string, string | undefined>> = process.env): Allowlist {
  const value = env[ALLOWED_HOSTS_ENV] ?? "";
  if (cache?.env === value) return cache.allowlist;
  const allowlist = buildAllowlist(value);
  cache = { env: value, allowlist };
  return allowlist;
}

/** Drop the cached allowlist (tests). */
export function resetAllowlistCache(): void {
  cache = null;
}

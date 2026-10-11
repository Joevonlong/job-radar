/**
 * How one request stands with the optional web password: configured or not, local, holding a valid session. Server /
 * Node only. Used by `src/proxy.ts` (the gate), the root layout (warning banner, sign-out button) and the auth routes.
 * Everything comes from `.env` (never from a config file the web can write) and the request headers.
 */
import { getConfigDir } from "@/lib/config/paths";

import { isLocalRequest, localExemptionEnabled, webListensOnLoopback, type HeaderSource } from "./local-request";
import { passwordVersion, readPasswordSetting, type PasswordSetting } from "./password";
import { isHttpsRequest, readSessionGeneration, sessionCookieName, sessionSecret, verifySessionToken } from "./session";

type Env = Readonly<Record<string, string | undefined>>;

export interface WebAccess {
  /** The password setting; null = no password (no login at all). */
  password: PasswordSetting | null;
  /** The request names this machine and carries no proxy header (whatever the bind address). */
  localRequest: boolean;
  /** The request may skip the login as a local one (loopback bind, `JOB_RADAR_WEB_LOCAL_LOGIN` not set). */
  localExempt: boolean;
  /** The web is known to listen (or be published) on a loopback address only (`JOB_RADAR_WEB_BIND`). */
  bindLoopback: boolean;
  /** The request carries a valid session cookie (always false without a password). */
  sessionValid: boolean;
}

/** Cookie lookup: `request.cookies` in the proxy and the route handlers, `cookies()` in pages and layouts. */
export interface CookieSource {
  get(name: string): { value: string } | undefined;
}

/**
 * Whether `token` is a valid session for `setting` in the current session generation; false (never a throw) when the
 * secret or the generation cannot be read.
 */
export function sessionIsValid(token: string | null | undefined, setting: PasswordSetting, env: Env = process.env, now: Date = new Date()): boolean {
  if (typeof token !== "string" || token === "") return false;
  try {
    const configDir = getConfigDir();
    const secret = sessionSecret(configDir, env);
    return verifySessionToken(token, secret, passwordVersion(setting, secret), now, readSessionGeneration(configDir));
  } catch {
    return false;
  }
}

/** The session token of a request: the `__Host-` cookie over https, the plain one over http. */
export function sessionToken(headers: HeaderSource, cookies: CookieSource): string | undefined {
  return cookies.get(sessionCookieName(isHttpsRequest(headers)))?.value;
}

export function readWebAccess(headers: HeaderSource, cookies: CookieSource, env: Env = process.env, now: Date = new Date()): WebAccess {
  const password = readPasswordSetting(env);
  const token = sessionToken(headers, cookies);
  const localRequest = isLocalRequest(headers, env);
  return {
    password,
    localRequest,
    localExempt: localRequest && localExemptionEnabled(env),
    bindLoopback: webListensOnLoopback(env),
    sessionValid: password !== null && sessionIsValid(token, password, env, now),
  };
}

/** The warning banner: no password, and the request does not come from this machine or the web listens beyond loopback. */
export function showAccessBanner(access: WebAccess): boolean {
  return access.password === null && (!access.localRequest || !access.bindLoopback);
}

/** The sign-out control: a password is set and this request got in with a session (not as a local one). */
export function showSignOut(access: WebAccess): boolean {
  return access.password !== null && !access.localExempt && access.sessionValid;
}

/** The request is locked out: a password is set and neither the local exemption nor a session lets it in. */
export function isLockedOut(access: WebAccess): boolean {
  return access.password !== null && !access.localExempt && !access.sessionValid;
}

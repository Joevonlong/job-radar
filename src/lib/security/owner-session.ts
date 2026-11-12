/**
 * Whether a request may change what agents are allowed to do: the switches and permissions in mcp.yaml, and agent tokens.
 * Unlike the page gate, a local request without a session does not count: another process on this machine could reach the web
 * without a login, and it must not be able to widen an agent's access or mint a token. Server only; the answer comes from the
 * request's own headers and cookies, never from what an action was sent.
 *
 * - `no_password`: no web password is set; nothing to log in to.
 * - `ok`: a password is set and the request carries a valid session.
 * - `login_required`: a password is set and there is no valid session, whether the request is local or not.
 */
import { cookies, headers } from "next/headers";

import type { HeaderSource } from "./local-request";
import { readWebAccess, type CookieSource } from "./web-access";

type Env = Readonly<Record<string, string | undefined>>;

export const OWNER_SESSION_STATES = ["no_password", "ok", "login_required"] as const;
export type OwnerSessionState = (typeof OWNER_SESSION_STATES)[number];

export function ownerSessionState(requestHeaders: HeaderSource, requestCookies: CookieSource, env: Env = process.env, now: Date = new Date()): OwnerSessionState {
  const access = readWebAccess(requestHeaders, requestCookies, env, now);
  if (access.password === null) return "no_password";
  return access.sessionValid ? "ok" : "login_required";
}

/** The state of the request being served (a Server Action or a page render). */
export async function requestOwnerSession(): Promise<OwnerSessionState> {
  return ownerSessionState(await headers(), await cookies());
}

export function ownerMayChange(state: OwnerSessionState): boolean {
  return state !== "login_required";
}

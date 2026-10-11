import { z } from "zod";

import type { AuthFileInfo } from "./auth-file";

/** What the user sees on /sources: no login file, a login that works (as far as we know), or one that has to be redone. */
export type LoginStatus = "missing" | "valid" | "expired";

/** Why a login counts as expired. */
export const EXPIRY_REASONS = ["login_required", "checkpoint", "blocked", "cookie_expired"] as const;
export type ExpiryReason = (typeof EXPIRY_REASONS)[number];

/** The last thing a session channel learned about the login, kept in `runtime_state` so every process (runner, web) sees it. */
export const authFlagSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("valid"), at: z.iso.datetime() }),
  z.object({ status: z.literal("expired"), reason: z.enum(EXPIRY_REASONS), at: z.iso.datetime() }),
]);
export type AuthFlag = z.infer<typeof authFlagSchema>;

export const AUTH_FLAG_KEY = "linkedin-session:auth";

export interface LoginState {
  status: LoginStatus;
  reason: ExpiryReason | null;
}

/**
 * The login status from the file and the last flag a channel saved:
 * - no file, or a file without LinkedIn's session cookie: `missing` ("未登录");
 * - the cookie is past its expiry, or a channel was sent to a login / verification page after the file was last written: `expired`;
 * - otherwise `valid`. A login redone later (the file is newer than the flag) clears an old flag by itself.
 */
export function loginStateOf(file: AuthFileInfo, flag: AuthFlag | null, now: Date): LoginState {
  if (!file.exists || !file.hasSessionCookie) return { status: "missing", reason: null };
  if (file.sessionCookieExpiresAt !== null && file.sessionCookieExpiresAt.getTime() <= now.getTime()) {
    return { status: "expired", reason: "cookie_expired" };
  }
  if (flag?.status === "expired" && (file.modifiedAt === null || file.modifiedAt.getTime() <= Date.parse(flag.at))) {
    return { status: "expired", reason: flag.reason };
  }
  return { status: "valid", reason: null };
}

/** Parse a stored flag; anything unexpected counts as "no flag". */
export function readAuthFlag(value: unknown): AuthFlag | null {
  const parsed = authFlagSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

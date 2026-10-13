import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { getDataRoot } from "@/lib/config";

/**
 * The login state of the LinkedIn session channels: a Playwright storage state (cookies + local storage) that
 * `pnpm auth:linkedin` writes after the user logged in themselves. It holds session cookies: it is gitignored,
 * mode 600, and only its metadata (existence, age, cookie expiry) is ever read here. No cookie value is returned or logged.
 */

/** LinkedIn's session cookie: present only while logged in. */
export const SESSION_COOKIE = "li_at";

const storageStateSchema = z.looseObject({
  cookies: z.array(
    z.looseObject({
      name: z.string(),
      domain: z.string().optional(),
      /** Unix seconds; -1 for a session cookie. */
      expires: z.number().optional(),
    }),
  ),
});
export type StorageState = z.infer<typeof storageStateSchema>;

export interface AuthFileInfo {
  path: string;
  exists: boolean;
  /** The file parses and holds LinkedIn's session cookie. */
  hasSessionCookie: boolean;
  /** When the session cookie expires; null for a session-lifetime cookie (or no cookie). */
  sessionCookieExpiresAt: Date | null;
  /** Last write of the file. */
  modifiedAt: Date | null;
}

/** The auth file path of `linkedin.session.site.auth_file`: relative paths are resolved against the data root (`getDataRoot`). */
export function resolveAuthFile(authFile: string, root: string = getDataRoot()): string {
  return path.resolve(root, authFile);
}

const MISSING = (file: string): AuthFileInfo => ({ path: file, exists: false, hasSessionCookie: false, sessionCookieExpiresAt: null, modifiedAt: null });

/** Metadata of the auth file; never throws (an unreadable or malformed file counts as "no login"). */
export function readAuthFileInfo(file: string): AuthFileInfo {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return MISSING(file);
  }
  if (!stat.isFile()) return MISSING(file);
  let state: StorageState;
  try {
    state = storageStateSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return { path: file, exists: true, hasSessionCookie: false, sessionCookieExpiresAt: null, modifiedAt: stat.mtime };
  }
  const cookie = state.cookies.find((c) => c.name === SESSION_COOKIE && (c.domain ?? "").includes("linkedin.com"));
  const expires = cookie?.expires;
  return {
    path: file,
    exists: true,
    hasSessionCookie: cookie !== undefined,
    sessionCookieExpiresAt: expires !== undefined && expires > 0 ? new Date(expires * 1000) : null,
    modifiedAt: stat.mtime,
  };
}

/** True when the file exists and holds a session cookie (does not check its expiry; the channel finds out on LinkedIn). */
export function hasLoginState(file: string): boolean {
  return readAuthFileInfo(file).hasSessionCookie;
}

/** A storage state is worth saving only while the user is logged in. */
export function isLoggedInState(state: unknown): boolean {
  const parsed = storageStateSchema.safeParse(state);
  return parsed.success && parsed.data.cookies.some((c) => c.name === SESSION_COOKIE && (c.domain ?? "").includes("linkedin.com"));
}

/** Write the storage state with owner-only permissions (directory 700, file 600), replacing the old file atomically. */
export function writeAuthFile(file: string, state: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

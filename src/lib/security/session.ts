/**
 * Web sessions after a password login: a signed token in the session cookie. Server / Node only (synchronous on
 * purpose: `src/proxy.ts` checks every request with it).
 *
 * Token: `base64url(JSON{v,iat,exp,pwv,gen}).base64url(HMAC-SHA256(secret, first part))`. `pwv` is the fingerprint of
 * the configured password (`passwordVersion`), so a new password invalidates every older session. `gen` is the session
 * generation: "sign out everywhere" (`bumpSessionGeneration`) raises it, which ends every session issued before. A token
 * without `gen` (issued before generations existed) counts as generation 0.
 *
 * Cookie: `__Host-jr_session` when the request came over https (`Secure`, `Path=/`, no `Domain`: no other site or plain
 * http page can set or overwrite it), `jr_session` over plain http (a browser refuses `__Host-` cookies there).
 *
 * Secret: `JOB_RADAR_SESSION_SECRET` (at least 32 characters), otherwise `<user config dir>/.web-session-secret`, created on
 * first use (32 random bytes, mode 0600). It is written to a temporary file first and then linked into place (a hard
 * link fails when the file exists, so two processes starting together keep one secret) or, when the file is there but
 * empty or too short (a crash, a hand edit), renamed over it; nobody ever reads a half-written secret. Losing or
 * deleting the file only logs everybody out.
 *
 * Generation: `<user config dir>/.web-session-generation` (a number, mode 0600; missing = 0). Read on every request, cached
 * by modification time and size. A file that cannot be read or holds no number fails closed (no session is valid).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

/** The cookie that carries the session over plain http. */
export const SESSION_COOKIE = "jr_session";
/** The cookie that carries the session over https. */
export const SECURE_SESSION_COOKIE = "__Host-jr_session";
/** The session generation file in the user config directory (a dot file: not a config file). */
export const SESSION_GENERATION_FILE = ".web-session-generation";
/** Optional fixed signing secret (otherwise a file is created). */
export const SESSION_SECRET_ENV = "JOB_RADAR_SESSION_SECRET";
/** The secret file in the user config directory (a dot file: not a config file, not in backups). */
export const SESSION_SECRET_FILE = ".web-session-secret";

const MIN_SECRET_CHARS = 32;
const SECRET_BYTES = 32;
const TOKEN_VERSION = 1;
/** A token longer than this is not one of ours. */
const MAX_TOKEN_CHARS = 512;
/** Clock skew tolerated for `iat` (seconds). */
const SKEW_SECONDS = 300;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const payloadSchema = z.strictObject({
  v: z.literal(TOKEN_VERSION),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  pwv: z.string().min(1).max(64),
  /** Session generation; absent in tokens issued before generations existed (= 0). */
  gen: z.number().int().nonnegative().optional(),
});

export type SessionPayload = z.infer<typeof payloadSchema>;

let cache: { key: string; secret: Buffer } | null = null;

/** Drop the cached secret (tests). */
export function resetSessionSecretCache(): void {
  cache = null;
}

function readSecretFile(file: string): Buffer | null {
  try {
    const text = fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8").trim();
    return text.length >= MIN_SECRET_CHARS ? Buffer.from(text, "utf8") : null;
  } catch {
    return null;
  }
}

/** A new secret in a temporary file next to `file` (mode 0600, flushed); returns its path and text. */
function writeTempSecret(file: string): { temp: string; text: string } {
  const text = randomBytes(SECRET_BYTES).toString("base64url");
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(/*turbopackIgnore: true*/ temp, "wx", 0o600);
  try {
    fs.writeSync(fd, `${text}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { temp, text };
}

function removeQuietly(file: string): void {
  try {
    fs.unlinkSync(/*turbopackIgnore: true*/ file);
  } catch {
    // already gone
  }
}

/**
 * Read the secret file, or create it when it does not exist yet (or replace it when it is empty or too short). Throws
 * when it can be neither read nor written.
 */
function fileSecret(configDir: string): Buffer {
  const file = path.join(configDir, SESSION_SECRET_FILE);
  const existing = readSecretFile(file);
  if (existing !== null) return existing;
  fs.mkdirSync(/*turbopackIgnore: true*/ configDir, { recursive: true });
  const { temp, text } = writeTempSecret(file);
  try {
    if (fs.existsSync(/*turbopackIgnore: true*/ file)) {
      // there, but unusable: replace it in one step
      fs.renameSync(/*turbopackIgnore: true*/ temp, file);
    } else {
      try {
        fs.linkSync(/*turbopackIgnore: true*/ temp, file);
      } catch (error) {
        // another process put its secret there first: use theirs
        const raced = readSecretFile(file);
        if (raced !== null) return raced;
        throw error;
      }
    }
  } finally {
    removeQuietly(temp);
  }
  // whatever is in place now (another process may have replaced a short file at the same moment)
  return readSecretFile(file) ?? Buffer.from(text, "utf8");
}

/**
 * The signing secret: `JOB_RADAR_SESSION_SECRET` when it is long enough, else the secret file (created on first use).
 * Cached per (variable, directory). Throws when the file can be neither read nor created (sessions then fail closed).
 */
export function sessionSecret(configDir: string, env: Readonly<Record<string, string | undefined>> = process.env): Buffer {
  const fromEnv = (env[SESSION_SECRET_ENV] ?? "").trim();
  const usable = fromEnv.length >= MIN_SECRET_CHARS ? fromEnv : "";
  const key = `${usable}\u0000${configDir}`;
  if (cache?.key === key) return cache.secret;
  const secret = usable !== "" ? Buffer.from(usable, "utf8") : fileSecret(configDir);
  cache = { key, secret };
  return secret;
}

/** Whether `JOB_RADAR_SESSION_SECRET` is set but too short to be used (doctor). */
export function sessionSecretTooShort(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const value = (env[SESSION_SECRET_ENV] ?? "").trim();
  return value !== "" && value.length < MIN_SECRET_CHARS;
}

function sign(secret: Buffer, data: string): Buffer {
  return createHmac("sha256", secret).update(data, "utf8").digest();
}

/** A new token valid for `maxAgeSeconds` from `now`, in session generation `generation`. */
export function createSessionToken(secret: Buffer, passwordVersion: string, maxAgeSeconds: number, now: Date = new Date(), generation = 0): string {
  const iat = Math.floor(now.getTime() / 1000);
  const payload: SessionPayload = { v: TOKEN_VERSION, iat, exp: iat + maxAgeSeconds, pwv: passwordVersion, gen: generation };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(secret, body).toString("base64url")}`;
}

/** Whether `token` is a valid, unexpired session for the current password and session generation. Never throws. */
export function verifySessionToken(token: string | null | undefined, secret: Buffer, passwordVersion: string, now: Date = new Date(), generation = 0): boolean {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [body, mac] = parts as [string, string];
  if (!BASE64URL.test(body) || !BASE64URL.test(mac)) return false;
  const expected = sign(secret, body);
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) return false;
  const seconds = Math.floor(now.getTime() / 1000);
  const payload = parsed.data;
  if (payload.exp <= seconds || payload.iat > seconds + SKEW_SECONDS || payload.exp <= payload.iat) return false;
  if ((payload.gen ?? 0) !== generation) return false;
  const left = Buffer.from(payload.pwv, "utf8");
  const right = Buffer.from(passwordVersion, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Whether the request came over https (`X-Forwarded-Proto`: Next fills it in for a direct request, a proxy sets it). */
export function isHttpsRequest(headers: { get(name: string): string | null }): boolean {
  return headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() === "https";
}

/** The session cookie's name for a request over https or plain http. */
export function sessionCookieName(https: boolean): string {
  return https ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
}

/** The generation after the current one; see `bumpSessionGeneration`. */
function nextGeneration(configDir: string, now: number = Date.now()): number {
  try {
    return readSessionGeneration(configDir) + 1;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith(SESSION_GENERATION_FILE)) throw error;
  }
  // the file is there but holds no number: jump well past whatever it held
  const text = fs.readFileSync(/*turbopackIgnore: true*/ path.join(configDir, SESSION_GENERATION_FILE), "utf8");
  const seen = Math.max(0, ...(text.match(/\d{1,15}/g) ?? []).map(Number));
  const next = Math.max(seen + 1, now);
  if (!Number.isSafeInteger(next) || String(next).length > 15) throw new Error(`${SESSION_GENERATION_FILE} cannot be raised any further`);
  console.warn(`[auth] ${SESSION_GENERATION_FILE} held no number: the session generation jumps to ${next}`);
  return next;
}

let generationCache: { file: string; mtimeMs: number; size: number; ino: number; value: number } | null = null;

/**
 * The current session generation: 0 when the file does not exist. Throws when it exists but cannot be read or holds no
 * number (callers treat that as "no session is valid").
 */
export function readSessionGeneration(configDir: string): number {
  const file = path.join(configDir, SESSION_GENERATION_FILE);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(/*turbopackIgnore: true*/ file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
  const cached = generationCache;
  if (cached !== null && cached.file === file && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.ino === stat.ino) return cached.value;
  const text = fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8").trim();
  if (!/^\d{1,15}$/.test(text)) throw new Error(`${SESSION_GENERATION_FILE} does not hold a number`);
  const value = Number(text);
  generationCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, value };
  return value;
}

/**
 * "Sign out everywhere": raise the session generation by one (written to a temporary file, then renamed over the old
 * one; mode 0600). Every session issued before ends. Returns the new generation.
 *
 * A file that exists but holds no number (a crash, a hand edit) never restarts the count at 1, which could bring back
 * sessions of an earlier generation: the new value is above any number still recognisable in it and at least the
 * current time in milliseconds, far above anything counting up one by one reaches. A file that cannot be read at all
 * (permissions) throws: the caller answers with an error.
 */
export function bumpSessionGeneration(configDir: string): number {
  const next = nextGeneration(configDir);
  const file = path.join(configDir, SESSION_GENERATION_FILE);
  fs.mkdirSync(/*turbopackIgnore: true*/ configDir, { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(/*turbopackIgnore: true*/ temp, "wx", 0o600);
  try {
    fs.writeSync(fd, `${next}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(/*turbopackIgnore: true*/ temp, file);
  } catch (error) {
    removeQuietly(temp);
    throw error;
  }
  generationCache = null;
  return next;
}

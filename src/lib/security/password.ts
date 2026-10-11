/**
 * The optional web password (`.env`, never a config file the web can write): hashing with scrypt and constant-time
 * verification. Server / Node only.
 *
 * Hash format: `scrypt:<N>:<r>:<p>:<salt>:<hash>`, salt and hash in base64url (no `$`, so docker compose never tries to
 * expand part of it as a variable, and no `:` inside a field). `pnpm web:password` prints one.
 */
import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

/** The variable with the hash (recommended). */
export const PASSWORD_HASH_ENV = "JOB_RADAR_WEB_PASSWORD_HASH";
/** The variable with a plain-text password (simple form; the hash wins when both are set). */
export const PASSWORD_PLAIN_ENV = "JOB_RADAR_WEB_PASSWORD";

const PREFIX = "scrypt";
/** Parameters of a new hash: N = 2^17, r = 8, p = 1 (128 MiB of memory per run; `maxmem` is passed explicitly). */
const DEFAULT_PARAMS = { N: 131_072, r: 8, p: 1 } as const;
/** A hash with a smaller scrypt N still works, but `pnpm run doctor` (web.access) warns: a stolen hash is cheap to guess. */
export const MIN_RECOMMENDED_SCRYPT_N = 2 ** 14;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** A hash with a cost above this is refused (it comes from .env, but a typo must not make every login take minutes). */
const MAX_MEMORY_BYTES = 512 * 1024 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derived) => (error ? reject(error) : resolve(derived)));
  });
}

function memoryOf(N: number, r: number): number {
  return 128 * N * r;
}

/** `maxmem` for one run: the memory scrypt needs plus headroom (Node refuses a run above maxmem). */
function maxmemOf(N: number, r: number): number {
  return memoryOf(N, r) + 32 * 1024 * 1024;
}

const isPowerOfTwo = (value: number): boolean => value > 1 && (value & (value - 1)) === 0;

/** The parts of a hash string; null when it is not one this code wrote (or the parameters are out of range). */
export function parsePasswordHash(text: string): ParsedHash | null {
  const parts = text.trim().split(":");
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;
  const [, nText, rText, pText, saltText, keyText] = parts as [string, string, string, string, string, string];
  if (![nText, rText, pText].every((value) => /^\d{1,8}$/.test(value))) return null;
  const N = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (!isPowerOfTwo(N) || r < 1 || r > 64 || p < 1 || p > 16) return null;
  if (memoryOf(N, r) > MAX_MEMORY_BYTES) return null;
  if (!BASE64URL.test(saltText) || !BASE64URL.test(keyText)) return null;
  const salt = Buffer.from(saltText, "base64url");
  const key = Buffer.from(keyText, "base64url");
  if (salt.length < 8 || key.length < 16 || key.length > 128) return null;
  return { N, r, p, salt, key };
}

/** A new hash of `password` (random salt). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const { N, r, p } = DEFAULT_PARAMS;
  const key = await scrypt(password, salt, KEY_BYTES, { N, r, p, maxmem: maxmemOf(N, r) });
  return [PREFIX, N, r, p, salt.toString("base64url"), key.toString("base64url")].join(":");
}

/** scrypt with the given parameters; the derived key has the length of `parsed.key`. */
function derive(password: string, parsed: ParsedHash): Promise<Buffer> {
  return scrypt(password, parsed.salt, parsed.key.length, { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: maxmemOf(parsed.N, parsed.r) });
}

/** A fixed, valid hash to burn the same time on when there is nothing real to compare against. */
let dummy: ParsedHash | null = null;
function dummyHash(): ParsedHash {
  dummy ??= { ...DEFAULT_PARAMS, salt: Buffer.alloc(SALT_BYTES, 7), key: Buffer.alloc(KEY_BYTES, 0) };
  return dummy;
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

/** The configured password: a hash (preferred) or a plain text; null when none is set. */
export type PasswordSetting = { kind: "hash"; hash: string; parsed: ParsedHash | null } | { kind: "plain"; plain: string };

/**
 * Read the password setting from the environment. A hash that cannot be parsed still counts as configured: the gate stays
 * closed (it matches nothing; the login answers `password_misconfigured`, the doctor fails), it never turns the login off.
 */
export function readPasswordSetting(env: Readonly<Record<string, string | undefined>> = process.env): PasswordSetting | null {
  const hash = (env[PASSWORD_HASH_ENV] ?? "").trim();
  if (hash !== "") return { kind: "hash", hash, parsed: parsePasswordHash(hash) };
  const plain = env[PASSWORD_PLAIN_ENV] ?? "";
  if (plain !== "") return { kind: "plain", plain };
  return null;
}

/**
 * Whether `attempt` is the configured password. Always runs one scrypt derivation, whatever the setting, so a wrong
 * password, an empty one and a plain-text setting take about the same time; the comparison is constant-time.
 */
export async function verifyPassword(attempt: string, setting: PasswordSetting): Promise<boolean> {
  if (setting.kind === "hash") {
    const parsed = setting.parsed;
    if (parsed === null) {
      await derive(attempt, dummyHash());
      return false;
    }
    const derived = await derive(attempt, parsed);
    return derived.length === parsed.key.length && timingSafeEqual(derived, parsed.key);
  }
  await derive(attempt, dummyHash());
  // both sides hashed first: equal length for timingSafeEqual, and the length of the password does not leak
  return timingSafeEqual(sha256(attempt), sha256(setting.plain));
}

/**
 * A short, stable fingerprint of the configured password, part of every session token so that changing the password ends
 * every session. An HMAC with the session secret of the hash string (or of the SHA-256 of the plain text): the cookie
 * never carries a value that could be used to guess the password offline.
 */
export function passwordVersion(setting: PasswordSetting, secret: Buffer): string {
  const material = setting.kind === "hash" ? `hash:${setting.hash}` : `plain:${sha256(setting.plain).toString("hex")}`;
  return createHmac("sha256", secret).update(`pwv:${material}`, "utf8").digest().subarray(0, 12).toString("base64url");
}

/** Length of a plain-text password setting (doctor: too short); null for a hash, whose length is unknown. */
export function plainPasswordLength(setting: PasswordSetting): number | null {
  return setting.kind === "plain" ? [...setting.plain].length : null;
}

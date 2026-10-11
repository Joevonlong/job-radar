import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The named volume of the compose `db` service (compose.yaml). The password only takes effect when this volume is created. */
export const DB_VOLUME_NAME = "jobradar-pg";
const PASSWORD_KEY = "POSTGRES_PASSWORD";
const PASSWORD_BYTES = 24; // 48 hex characters: URL-safe, as `.env.example` asks (it is embedded in DATABASE_URL)

/** The value of `KEY=value` in a dotenv text (surrounding quotes removed); null when absent. */
export function envValue(text: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}\\s*=(.*)$`, "m").exec(text);
  if (!match) return null;
  return (match[1] ?? "").trim().replace(/^(['"])(.*)\1$/, "$2");
}

/** The dotenv text with `KEY=value` set: an existing (possibly empty) line is replaced, otherwise one is appended. */
export function withEnvValue(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, "m");
  if (pattern.test(text)) return text.replace(pattern, line);
  const separator = text === "" || text.endsWith("\n") ? "" : "\n";
  return `${text}${separator}${line}\n`;
}

/** true / false when Docker answers whether the db volume exists; null when it cannot tell (no Docker, daemon down). */
export async function dockerDbVolumeExists(): Promise<boolean | null> {
  try {
    await execFileAsync("docker", ["volume", "inspect", DB_VOLUME_NAME], { timeout: 15_000 });
    return true;
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    return /no such volume/i.test(stderr) ? false : null;
  }
}

export type DbPasswordOutcome = "generated" | "has_password" | "database_exists" | "unknown" | "external_database";

export interface EnsureDbPasswordOptions {
  /** The `.env` file of the checkout. */
  envFile: string;
  env?: Record<string, string | undefined>;
  volumeExists?: () => Promise<boolean | null>;
  /** 48 hex characters by default; tests inject one. */
  generate?: () => string;
}

/**
 * New installs only: when `.env` sets no POSTGRES_PASSWORD and the database volume does not exist yet, write a random one
 * (otherwise the database listens on 127.0.0.1 with the well-known default `jobradar`). An existing volume keeps the
 * password it was created with, so changing `.env` then would lock web, runner and the host tools out: nothing is written.
 * A DATABASE_URL in the environment means the database is not the compose one: nothing is written either.
 */
export async function ensureDbPassword(options: EnsureDbPasswordOptions): Promise<DbPasswordOutcome> {
  const env = options.env ?? process.env;
  if ((env.DATABASE_URL ?? "").trim() !== "") return "external_database";
  let text = "";
  try {
    text = await readFile(options.envFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if ((envValue(text, PASSWORD_KEY) ?? "") !== "") return "has_password";
  const exists = await (options.volumeExists ?? dockerDbVolumeExists)();
  if (exists === null) return "unknown";
  if (exists) return "database_exists";
  const password = (options.generate ?? (() => randomBytes(PASSWORD_BYTES).toString("hex")))();
  const temp = `${options.envFile}.${process.pid}.tmp`;
  await writeFile(temp, withEnvValue(text, PASSWORD_KEY, password), { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, options.envFile);
  return "generated";
}

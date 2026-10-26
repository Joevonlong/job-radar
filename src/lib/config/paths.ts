import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { configRegistry, type ConfigName } from "./registry";

/**
 * App root = the project directory (the one whose package.json is named "job-radar").
 *
 * It is found by walking up from this module, not from `process.cwd()`, so it is the same
 * whether code runs under `next dev`, `tsx scripts/...`, vitest or in the container.
 * Falls back to `process.cwd()` only if no marker is found.
 */
export function getAppRoot(): string {
  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
  for (;;) {
    const pkg = path.join(dir, "package.json");
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ pkg, "utf8"));
      if (typeof parsed === "object" && parsed !== null && "name" in parsed && parsed.name === "job-radar") {
        return dir;
      }
    } catch {
      // no readable package.json here, keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

function resolveFromEnv(envVar: string, fallbackRelative: string): string {
  const root = getAppRoot();
  const value = process.env[envVar];
  const chosen = value !== undefined && value.trim() !== "" ? value.trim() : fallbackRelative;
  return path.resolve(root, chosen);
}

/**
 * The root of the user's data, `JOB_RADAR_DATA_ROOT` (default: the app root). Relative paths that point at user data
 * outside the config and profile directories (the resume export directory, the LinkedIn auth file) resolve against it,
 * so a worker running from a release directory still finds them in the checkout's data. A relative value resolves
 * against the app root.
 */
export function getDataRoot(): string {
  return resolveFromEnv("JOB_RADAR_DATA_ROOT", ".");
}

/**
 * The shipped defaults directory, `JOB_RADAR_DEFAULTS_DIR` (default `<app root>/config`). It ships with the
 * product (tracked in git) and is only ever read: a config file the user directory lacks is read from here.
 */
export function getDefaultsDir(): string {
  return resolveFromEnv("JOB_RADAR_DEFAULTS_DIR", "config");
}

/**
 * The user config directory, `JOB_RADAR_CONFIG_DIR` (default `<app root>/data/config`, not in git). Every write goes
 * here; a file here wins over the same file in the defaults directory. Relative values resolve against the app root.
 */
export function getConfigDir(): string {
  return resolveFromEnv("JOB_RADAR_CONFIG_DIR", path.join("data", "config"));
}

/** `JOB_RADAR_PROFILE_DIR` (default `<app root>/data/profile`). Relative values resolve against the app root. */
export function getProfileDir(): string {
  return resolveFromEnv("JOB_RADAR_PROFILE_DIR", path.join("data", "profile"));
}

/** Directory holding the shipped profile templates (in the defaults directory). */
export function getProfileExampleDir(): string {
  return path.join(getDefaultsDir(), "profile.example");
}

/** Where a config is written: the user config directory (profile files: the profile directory). */
export function getUserConfigPath(name: ConfigName): string {
  const entry = configRegistry[name];
  return path.join(entry.location === "config" ? getConfigDir() : getProfileDir(), entry.file);
}

/** The shipped config default; profiles have templates, not a default config layer. */
export function getDefaultConfigPath(name: ConfigName): string | null {
  const entry = configRegistry[name];
  return entry.location === "config" ? path.join(/*turbopackIgnore: true*/ getDefaultsDir(), entry.file) : null;
}

/** Alias of `getUserConfigPath`: the file the app writes (and the cache key). Use `resolveConfigPath` for the file it reads. */
export function getConfigPath(name: ConfigName): string {
  return getUserConfigPath(name);
}

/** Which layer a config is read from: `user` (user directory or profile directory), `default` (defaults directory) or `missing`. */
export type ConfigLayer = "user" | "default" | "missing";

/** The layer a config is read from right now (the user file wins; see `resolveConfigPath`). */
export function configLayer(name: ConfigName): ConfigLayer {
  if (fs.existsSync(/*turbopackIgnore: true*/ getUserConfigPath(name))) return "user";
  const shipped = getDefaultConfigPath(name);
  return shipped !== null && fs.existsSync(/*turbopackIgnore: true*/ shipped) ? "default" : "missing";
}

/**
 * The file a config is read from: the user file when it exists, else the shipped default. When neither exists this is
 * the user path (so "not found" names the file the user is expected to create).
 */
export function resolveConfigPath(name: ConfigName): string {
  return configLayer(name) === "default" ? (getDefaultConfigPath(name) ?? getUserConfigPath(name)) : getUserConfigPath(name);
}

/** Reader-only profile fallback: keep missing-file/layer/override semantics separate from loading a usable template. */
export function resolveConfigReadPath(name: ConfigName): string {
  const file = resolveConfigPath(name);
  const entry = configRegistry[name];
  if (entry.location === "profile" && !fs.existsSync(/*turbopackIgnore: true*/ file)) {
    const template = path.join(getProfileExampleDir(), entry.file);
    if (fs.existsSync(/*turbopackIgnore: true*/ template)) return template;
  }
  return file;
}

/** Relative inside the app root (`data/config/ai.yaml`), except explicitly absolute directory overrides stay absolute. */
export function displayConfigPath(file: string): string {
  for (const key of ["JOB_RADAR_DEFAULTS_DIR", "JOB_RADAR_CONFIG_DIR", "JOB_RADAR_PROFILE_DIR"]) {
    const dir = process.env[key]?.trim();
    if (!dir || !path.isAbsolute(dir)) continue;
    const relative = path.relative(dir, file);
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return file;
  }
  const relative = path.relative(getAppRoot(), file);
  return relative === "" || relative.startsWith("..") || path.isAbsolute(relative) ? file : relative;
}

/**
 * A path for the web pages (Settings): like `displayConfigPath`, but a file of a config or profile directory that lives outside the app
 * (`JOB_RADAR_CONFIG_DIR`) is shown under its conventional name (`data/config/schedule.yaml`) instead of the machine's absolute path; so is a
 * shipped file of a moved defaults directory (`JOB_RADAR_DEFAULTS_DIR`, shown as `config/<file>`).
 * The CLI and the doctor keep the real path (`displayConfigPath`), where it is what the reader needs.
 */
export function displayConfigPathForWeb(file: string): string {
  const shown = displayConfigPath(file);
  if (shown !== file) return shown;
  const inside = (base: string): string | null => {
    const relative = path.relative(base, file);
    return relative.startsWith("..") || path.isAbsolute(relative) ? null : relative;
  };
  const underConfig = inside(getConfigDir());
  if (underConfig !== null) return path.join("data", "config", underConfig);
  const underProfile = inside(getProfileDir());
  if (underProfile !== null) return path.join("data", "profile", underProfile);
  const underDefaults = inside(getDefaultsDir());
  if (underDefaults !== null) return path.join("config", underDefaults);
  return file;
}

/** The config poll interval (ms) when `JOB_RADAR_CONFIG_POLL_MS` is unset or invalid. */
export const DEFAULT_CONFIG_POLL_MS = 5000;

/** `JOB_RADAR_CONFIG_POLL_MS` (default 5000). 0 disables polling. */
export function getPollIntervalMs(): number {
  const raw = process.env.JOB_RADAR_CONFIG_POLL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_CONFIG_POLL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_CONFIG_POLL_MS;
}

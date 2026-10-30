import fs from "node:fs";

import type { Document } from "yaml";

import { ConfigError, zodIssues } from "./errors";
import { isExistingInstall } from "./install";
import { EXISTING_INSTALL_LANGUAGE_YAML } from "./migrations/language/existing-install";
import { migrateConfigDocument, withoutConfigVersion, type DocumentMigrationResult } from "./migrations/version";
import { getDefaultsDir, getPollIntervalMs, getUserConfigPath, resolveConfigPath, resolveConfigReadPath } from "./paths";
import { CONFIG_NAMES, configRegistry, isProfileName, type ConfigName, type ConfigValue, type ProfileName } from "./registry";
import { parseConfigYamlDocument } from "./yaml-options";

interface CacheEntry {
  value: unknown;
  text: string;
}

/** Keyed by the user file path plus the defaults directory, so changing JOB_RADAR_*_DIR never serves stale values. */
const cache = new Map<string, CacheEntry>();

/**
 * When the cache was last brought in line with the files (ms, `Date.now()`), or null while nothing is cached. The
 * on-demand refresh in `loadConfig` compares it with the poll interval.
 */
let lastRefreshAt: number | null = null;

/** Number of running `watchConfig` watchers in this process; while there is one, `loadConfig` leaves refreshing to it. */
let activeWatchers = 0;

/** Internal: `watchConfig` calls this when it starts; the returned function undoes it (call once). */
export function registerConfigWatcher(): () => void {
  activeWatchers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeWatchers -= 1;
  };
}

/** The bad file text last reported per config (or a marker when the file could not be read), so one bad content is reported once. */
const reportedBad = new Map<ConfigName, string>();

function cacheKey(name: ConfigName): string {
  return `${getUserConfigPath(name)}\u0000${getDefaultsDir()}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * The file a config is read from: the user file when it exists, else the shipped default.
 */
export function configSourcePath(name: ConfigName): string {
  return resolveConfigPath(name);
}

/**
 * Read the raw YAML text of a config file (user file first, then the shipped default). Throws ConfigError(missing | read).
 */
export function readConfigText(name: ConfigName): string {
  // Startup fills can be deferred by an upgrade freeze. Keep the same install-specific default until it is written.
  if (name === "language" && !fs.existsSync(/*turbopackIgnore: true*/ getUserConfigPath(name)) && isExistingInstall()) return EXISTING_INSTALL_LANGUAGE_YAML;
  return readTextAt(name, resolveConfigPath(name));
}

/** Runtime profile readers can use a template without changing raw-file inspection, layers, doctor or watcher state. */
export function readProfileText(name: ProfileName): string {
  return readTextAt(name, resolveConfigReadPath(name));
}

function readTextAt(name: ConfigName, filePath: string): string {
  try {
    return fs.readFileSync(/*turbopackIgnore: true*/ filePath, "utf8");
  } catch (err) {
    const code = err instanceof Error && "code" in err ? String(err.code) : "";
    throw new ConfigError({
      configName: name,
      filePath,
      kind: code === "ENOENT" ? "missing" : "read",
      detail: code === "ENOENT" ? undefined : code || "read error",
    });
  }
}

function readForLoad(name: ConfigName): string {
  return isProfileName(name) ? readProfileText(name) : readConfigText(name);
}

/**
 * Parse YAML text into a document with the shared options (`yaml-options.ts`: unresolved tags and `!unset` are errors);
 * throws ConfigError(yaml) naming the line, never the contents.
 */
export function parseConfigDocument(name: ConfigName, text: string, filePath: string): Document {
  const doc = parseConfigYamlDocument(text);
  if (doc.errors.length > 0) {
    const first = doc.errors[0];
    const where = first?.linePos?.[0];
    // yaml appends a source excerpt after the first line of the message; keep only the first line.
    const reason = (first?.message ?? "invalid YAML").split("\n")[0] ?? "invalid YAML";
    throw new ConfigError({
      configName: name,
      filePath,
      kind: "yaml",
      detail: where ? `line ${where.line}, column ${where.col}: ${reason}` : reason,
    });
  }
  return doc;
}

/** Validate an already parsed (and migrated) value against the config's schema; `config_version` is not part of it. */
export function validateConfigValue<N extends ConfigName>(name: N, raw: unknown, filePath: string): ConfigValue<N> {
  const result = configRegistry[name].schema.safeParse(withoutConfigVersion(raw));
  if (!result.success) {
    throw new ConfigError({ configName: name, filePath, kind: "schema", issues: zodIssues(result.error) });
  }
  return result.data as ConfigValue<N>;
}

/**
 * Parse, migrate (in memory) and validate YAML text for the given config. Pure: no cache, no disk access.
 * Errors name the file and the field paths, never the file contents.
 */
export function parseConfigText<N extends ConfigName>(name: N, text: string, filePath = configSourcePath(name)): ConfigValue<N> {
  return parseConfigTextWithVersion(name, text, filePath).value;
}

/** `parseConfigText` plus what the in-memory migration did (from / to version and the steps that ran). */
export function parseConfigTextWithVersion<N extends ConfigName>(name: N, text: string, filePath = configSourcePath(name)): { value: ConfigValue<N>; migration: DocumentMigrationResult } {
  const doc = parseConfigDocument(name, text, filePath);
  const migration = migrateConfigDocument(name, doc, filePath);
  return { value: validateConfigValue(name, doc.toJS(), filePath), migration };
}

/** Re-read the file, validate and replace the cache entry. On failure the previous cache entry is kept. */
export function reloadConfig<N extends ConfigName>(name: N): ConfigValue<N> {
  const text = readForLoad(name);
  const value = deepFreeze(parseConfigText(name, text, resolveConfigReadPath(name)));
  setEntry(name, value, text);
  return value;
}

function setEntry(name: ConfigName, value: unknown, text: string): void {
  if (cache.size === 0) lastRefreshAt = Date.now();
  // a good value is in the cache now: the same bad content coming back later is a new problem
  reportedBad.delete(name);
  cache.set(cacheKey(name), { value, text });
}

/**
 * Load, validate and cache a config. Subsequent calls return the cached value until
 * `reloadConfig` (used by the watcher) or `writeConfig` refreshes it.
 * A process without a watcher (the web, the MCP server) would never see a change another process made, so there a call
 * made more than `JOB_RADAR_CONFIG_POLL_MS` after the last check first brings the whole cache in line with the files
 * (`refreshStaleCache`). With a watcher running, or with the interval 0, nothing here reads the disk.
 * Returned values are deeply frozen: treat them as read-only and use `writeConfig` to change them.
 */
export function loadConfig<N extends ConfigName>(name: N): ConfigValue<N> {
  let hit = cache.get(cacheKey(name));
  if (hit && refreshStaleCache()) hit = cache.get(cacheKey(name));
  if (hit) return hit.value as ConfigValue<N>;
  return reloadConfig(name);
}

/**
 * The throttled on-demand refresh behind `loadConfig`; true when it ran. The timestamp is taken before the read, so a
 * throw or a re-entrant call cannot make it loop. A bad file keeps its last good value and is reported once per distinct
 * content (as the watcher does); `refreshConfigCache` never throws.
 */
function refreshStaleCache(): boolean {
  if (activeWatchers > 0) return false;
  const interval = getPollIntervalMs();
  if (interval <= 0) return false;
  const now = Date.now();
  if (lastRefreshAt !== null && now - lastRefreshAt < interval) return false;
  lastRefreshAt = now;
  for (const error of refreshCacheEntries(true).errors) {
    console.error(`[config] ${error.message}\n[config] keeping the last valid value`);
  }
  return true;
}

/** Internal: used by writeConfig to refresh the cache with what it just wrote. */
export function primeConfigCache<N extends ConfigName>(name: N, value: ConfigValue<N>, text: string): void {
  setEntry(name, deepFreeze(value), text);
}

export interface ConfigRefreshResult {
  /** Configs whose file text changed since they were cached; the cache now holds the new value. */
  changed: ConfigName[];
  /** Configs whose changed file could not be read or validated; the last good value stays cached. */
  errors: ConfigError[];
}

/**
 * Bring every cached config in line with its file, synchronously. Long-running processes (runner, ai-worker) call
 * this at the start of each cycle and each control request, so a change made by another process (the web writing
 * preferences.yaml from the wizard or /me) is in effect for the work that follows, without waiting for the watcher's
 * debounce or poll and without depending on a hand-kept list of watched names.
 *
 * Only configs already cached are re-read (one small file read each; an uncached config is read fresh on first use).
 * Derived caches are keyed by the config objects (WeakMap) or by file signatures, so they follow on their own. A file that
 * is missing or invalid keeps the last good value, as with the watcher; so does any other error (reported as kind `read`).
 * Never throws.
 */
export function refreshConfigCache(): ConfigRefreshResult {
  lastRefreshAt = Date.now();
  return refreshCacheEntries(false);
}

/**
 * The loop behind `refreshConfigCache`. `reportOnce` (the on-demand refresh): a file that stays bad with the same content
 * is reported only the first time, and a file that is good again (or equal to the cache) forgets that it was bad.
 */
function refreshCacheEntries(reportOnce: boolean): ConfigRefreshResult {
  const changed: ConfigName[] = [];
  const errors: ConfigError[] = [];
  for (const name of CONFIG_NAMES) {
    const key = cacheKey(name);
    const hit = cache.get(key);
    if (hit === undefined) continue;
    // What was read, to tell "the same bad content again" from a new one; a file that cannot be read has no text.
    let badContent = "";
    try {
      const text = readForLoad(name);
      if (text === hit.text) {
        reportedBad.delete(name);
        continue;
      }
      badContent = text;
      const value = deepFreeze(parseConfigText(name, text, resolveConfigReadPath(name)));
      cache.set(key, { value, text });
      reportedBad.delete(name);
      changed.push(name);
    } catch (err) {
      // Never throws: a bug in a migration step must not take the cycle or a claimed request down with it.
      const error = err instanceof ConfigError ? err : new ConfigError({ configName: name, filePath: configSourcePath(name), kind: "read", detail: unexpectedDetail(err) });
      if (reportOnce) {
        const marker = badContent === "" ? `\u0000${error.kind}` : badContent;
        if (reportedBad.get(name) === marker) continue;
        reportedBad.set(name, marker);
      }
      errors.push(error);
    }
  }
  return { changed, errors };
}

function unexpectedDetail(err: unknown): string {
  return (err instanceof Error ? `${err.name}: ${err.message}` : "unexpected error").split("\n")[0] ?? "unexpected error";
}

/** Drop all cached values (tests, or after changing the config directories). */
export function resetConfigCache(): void {
  cache.clear();
  reportedBad.clear();
  lastRefreshAt = null;
}

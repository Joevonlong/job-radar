import fs from "node:fs";

import { parseDocument, type Document } from "yaml";

import { ConfigError, zodIssues } from "./errors";
import { migrateConfigDocument, withoutConfigVersion, type DocumentMigrationResult } from "./migrations/version";
import { getDefaultsDir, getUserConfigPath, resolveConfigPath } from "./paths";
import { CONFIG_NAMES, configRegistry, type ConfigName, type ConfigValue } from "./registry";

interface CacheEntry {
  value: unknown;
  text: string;
}

/** Keyed by the user file path plus the defaults directory, so changing JOB_RADAR_*_DIR never serves stale values. */
const cache = new Map<string, CacheEntry>();

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
  const filePath = resolveConfigPath(name);
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

/** Parse YAML text into a document; throws ConfigError(yaml) naming the line, never the contents. */
export function parseConfigDocument(name: ConfigName, text: string, filePath: string): Document {
  const doc = parseDocument(text, { uniqueKeys: true });
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
  const text = readConfigText(name);
  const value = deepFreeze(parseConfigText(name, text, configSourcePath(name)));
  cache.set(cacheKey(name), { value, text });
  return value;
}

/**
 * Load, validate and cache a config. Subsequent calls return the cached value until
 * `reloadConfig` (used by the watcher) or `writeConfig` refreshes it.
 * Returned values are deeply frozen: treat them as read-only and use `writeConfig` to change them.
 */
export function loadConfig<N extends ConfigName>(name: N): ConfigValue<N> {
  const hit = cache.get(cacheKey(name));
  if (hit) return hit.value as ConfigValue<N>;
  return reloadConfig(name);
}

/** Internal: used by writeConfig to refresh the cache with what it just wrote. */
export function primeConfigCache<N extends ConfigName>(name: N, value: ConfigValue<N>, text: string): void {
  cache.set(cacheKey(name), { value: deepFreeze(value), text });
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
  const changed: ConfigName[] = [];
  const errors: ConfigError[] = [];
  for (const name of CONFIG_NAMES) {
    const key = cacheKey(name);
    const hit = cache.get(key);
    if (hit === undefined) continue;
    try {
      const text = readConfigText(name);
      if (text === hit.text) continue;
      const value = deepFreeze(parseConfigText(name, text, configSourcePath(name)));
      cache.set(key, { value, text });
      changed.push(name);
    } catch (err) {
      // Never throws: a bug in a migration step must not take the cycle or a claimed request down with it.
      errors.push(err instanceof ConfigError ? err : new ConfigError({ configName: name, filePath: configSourcePath(name), kind: "read", detail: unexpectedDetail(err) }));
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
}

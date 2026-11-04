
import type { Document } from "yaml";

import { ConfigError, zodIssues, type ConfigIssue } from "./errors";
import { layeredFingerprint } from "./hash";
import { isPlainMap, mergeLayers } from "./merge";
import { issuesInUserFile, mergeModelsWithShipped, type ModelsMerge, type OverlayIssue } from "./models-overlay";
import { CONFIG_VERSION_KEY, documentConfigVersion, hasOverlayFormat, isOverlayVersion, migrateConfigDocument, overlayFormatVersion, withoutConfigVersion, type DocumentMigrationResult } from "./migrations/version";
import { replaceRule } from "./overlay-rules";
import { getDefaultConfigPath, getDefaultsDir, getPollIntervalMs, getUserConfigPath, readOverlayText, readShippedText, resolveConfigPath, resolveConfigReadPath } from "./paths";
import { CONFIG_NAMES, configRegistry, isProfileName, type ConfigName, type ConfigValue, type ProfileName } from "./registry";
import { readUserText } from "./read-user-file";
import { containsUnset, parseConfigYamlDocument, UNSET_TAG } from "./yaml-options";

interface CacheEntry {
  value: unknown;
  /** The layered fingerprint of what `value` was parsed from: an unchanged fingerprint skips the parse. */
  fingerprint: string;
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

/** The fingerprint last reported as bad per config (or a marker when a file could not be read), so one bad content is reported once. */
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
 * The raw YAML text of the user's file: an overlay, or a whole file not converted yet. Not the shipped file, so it is never
 * a value by itself: use `loadConfig` / `readEffectiveConfig` for values and `layeredConfigFingerprint` to tell versions
 * apart. Throws ConfigError(`missing` when there is no user file, `read`).
 */
export function readConfigText(name: ConfigName): string {
  const text = readOverlayText(name);
  if (text === null) throw new ConfigError({ configName: name, filePath: getUserConfigPath(name), kind: "missing", layer: "user" });
  return text;
}

/** Runtime profile readers can use a template without changing raw-file inspection, layers, doctor or watcher state. */
export function readProfileText(name: ProfileName): string {
  return readTextAt(name, resolveConfigReadPath(name));
}

function readTextAt(name: ConfigName, filePath: string): string {
  try {
    return readUserText(filePath);
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

/** One snapshot of a config's files, read once each: what a value is parsed from and what the cache compares. */
export interface ConfigLayerTexts {
  overlay: string | null;
  shipped: string | null;
  fingerprint: string;
}

/** The two layers of a config, each read once. A profile file has one: its template is only read while there is no file. */
export function readConfigLayers(name: ConfigName): ConfigLayerTexts {
  const overlay = readOverlayText(name);
  const shipped = isProfileName(name) && overlay !== null ? null : readShippedText(name);
  return { overlay, shipped, fingerprint: layeredFingerprint(overlay, shipped) };
}

/** Parse one snapshot; nothing here reads a layer again. Throws ConfigError(`missing` when neither layer exists, ...). */
export function parseConfigLayers<N extends ConfigName>(name: N, layers: ConfigLayerTexts): ConfigValue<N> {
  const file = resolveConfigReadPath(name);
  if (layers.overlay !== null) warnMissingVersion(name, layers.overlay);
  const text = layers.overlay ?? layers.shipped;
  if (text === null) throw new ConfigError({ configName: name, filePath: getUserConfigPath(name), kind: "missing" });
  if (layers.overlay === null && hasOverlayFormat(name)) {
    const shipped = shippedEffective(name, text, file);
    return validateConfigValue(name, shipped.value, file);
  }
  return parseConfigTextWithVersion(name, text, file, layers.shipped).value;
}

/** The validated value of a config as it is on disk now, not cached (a preview, a check, another file's cross-check). */
export function readEffectiveConfig<N extends ConfigName>(name: N): ConfigValue<N> {
  return parseConfigLayers(name, readConfigLayers(name));
}

/** What the schema gets for a config as it is on disk now: the merged, migrated value before validation. */
export function readEffectiveRaw(name: ConfigName): unknown {
  const layers = readConfigLayers(name);
  const file = resolveConfigReadPath(name);
  const text = layers.overlay ?? layers.shipped;
  if (text === null) throw new ConfigError({ configName: name, filePath: getUserConfigPath(name), kind: "missing" });
  const doc = parseConfigDocument(name, text, file);
  migrateConfigDocument(name, doc, file);
  return withoutConfigVersion(resolveConfigDocument(name, doc, layers.shipped).value);
}

/** A user file with the overlay format available that does not say its version (so it is read as a whole file). */
export function fileLacksVersion(name: ConfigName): boolean {
  if (!hasOverlayFormat(name)) return false;
  try {
    const text = readOverlayText(name);
    return text !== null && !/^config_version\s*:/m.test(text);
  } catch {
    return false;
  }
}

/** The validated value of the shipped layer alone, or null when there is no shipped file or it is not valid. */
export function readShippedConfig<N extends ConfigName>(name: N): ConfigValue<N> | null {
  const file = getDefaultConfigPath(name);
  if (file === null) return null;
  try {
    const text = readShippedText(name);
    if (text === null) return null;
    return hasOverlayFormat(name) ? validateConfigValue(name, shippedEffective(name, text, file).value, file) : parseConfigText(name, text, file);
  } catch {
    return null;
  }
}

/** A file with `config_version` missing is read as a whole file; said once per file and process. */
const warnedMissingVersion = new Set<string>();

function warnMissingVersion(name: ConfigName, text: string): void {
  if (!hasOverlayFormat(name) || /^config_version\s*:/m.test(text)) return;
  const file = getUserConfigPath(name);
  if (warnedMissingVersion.has(file)) return;
  warnedMissingVersion.add(file);
  console.warn(`[config] ${file} has no ${CONFIG_VERSION_KEY}: it is read as a whole file, and missing keys take the schema's defaults`);
}

function withLayer(error: unknown, layer: "user" | "shipped"): unknown {
  if (!(error instanceof ConfigError) || error.layer !== undefined) return error;
  return new ConfigError({ configName: error.configName, filePath: error.filePath, kind: error.kind, issues: error.issues, detail: error.detail, layer });
}

export interface ShippedEffective {
  /** The migrated document. */
  doc: Document;
  /** Its plain value, without `config_version`. */
  value: unknown;
}

/**
 * The shipped layer's value: the text parsed (the shipped file has no `!unset`) and migrated in memory (a file newer than
 * the code is an error). Works on the text it is given: it does not read files and does not use the cache.
 */
export function shippedEffective(name: ConfigName, text: string, filePath: string): ShippedEffective {
  try {
    const doc = parseYamlOrThrow(name, parseConfigYamlDocument(text), filePath);
    migrateConfigDocument(name, doc, filePath);
    return { doc, value: withoutConfigVersion(doc.toJS()) };
  } catch (error) {
    throw withLayer(error, "shipped");
  }
}

function parseYamlOrThrow(name: ConfigName, doc: Document, filePath: string): Document {
  if (doc.errors.length === 0) return doc;
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

/**
 * Parse a user file's YAML text into a document with the shared options (`yaml-options.ts`: unresolved tags are errors);
 * throws ConfigError(yaml) naming the line, never the contents. `!unset` is only for a file with the overlay format, and
 * only at its version: anywhere else it is an error that says what to add.
 */
export function parseConfigDocument(name: ConfigName, text: string, filePath: string): Document {
  if (!hasOverlayFormat(name)) return parseYamlOrThrow(name, parseConfigYamlDocument(text), filePath);
  const doc = parseYamlOrThrow(name, parseConfigYamlDocument(text, { unset: "overlay" }), filePath);
  const version = documentConfigVersion(doc);
  if (version !== null && !isOverlayVersion(name, version) && containsUnset(doc.toJS())) {
    throw new ConfigError({ configName: name, filePath, kind: "yaml", detail: `${UNSET_TAG} needs the overlay format: add \`${CONFIG_VERSION_KEY}: ${overlayFormatVersion(name)}\` to the file` });
  }
  return doc;
}

/** Validate an already parsed (and migrated) value against the config's schema; `config_version` is not part of it. */
export function validateConfigValue<N extends ConfigName>(name: N, raw: unknown, filePath: string, userRaw?: unknown): ConfigValue<N> {
  const result = configRegistry[name].schema.safeParse(withoutConfigVersion(raw));
  if (!result.success) {
    let issues: ConfigIssue[] = zodIssues(result.error);
    // an overlay's value is the merged one: its problems are shown at the positions of the user's file
    if (userRaw !== undefined) issues = name === "models" ? issuesInUserFile(issues, raw, withoutConfigVersion(userRaw)) : issues.map((issue) => ({ ...issue, layer: layerOfIssue(issue.path, withoutConfigVersion(userRaw)) }));
    throw new ConfigError({ configName: name, filePath, kind: "schema", issues });
  }
  return result.data as ConfigValue<N>;
}

/** Which layer holds the value at a dotted zod path: the user's when the overlay has any key on the way. */
function layerOfIssue(path: string, overlay: unknown): "user" | "shipped" {
  let node = overlay;
  for (const key of path.split(/[.[\]]+/).filter((segment) => segment !== "")) {
    if (!isPlainMap(node)) return "user";
    if (!Object.hasOwn(node, key)) return "shipped";
    node = node[key];
  }
  return "user";
}

/**
 * Parse, migrate (in memory) and validate YAML text as the user's file of the given config: a whole file by itself, an
 * overlay (its version says so) merged over the shipped file. No cache; the shipped file is the one disk access
 * (`resolveConfigDocument`). The shipped text passed as `text` gives the shipped value.
 * Errors name the file and the field paths, never the file contents.
 */
export function parseConfigText<N extends ConfigName>(name: N, text: string, filePath = configSourcePath(name)): ConfigValue<N> {
  return parseConfigTextWithVersion(name, text, filePath).value;
}

/**
 * The plain value of a parsed (and migrated) document as the schema takes it, with what a layered file needs on top.
 * - An overlay (its version is the overlay format's): the shipped value with the overlay's keys merged over it, key by key.
 * - models.yaml: the shipped catalog with this file's models merged in (`models-overlay.ts`), its own by-id overlay.
 * - A whole file (profile files, a file not converted yet): the document's value.
 *
 * `shippedText` is the shipped file's text when the caller has read it. `errors` are clashes in the overlay (they make the
 * file invalid), `warnings` are things the merge dropped.
 */
export function resolveConfigDocument(name: ConfigName, doc: Document, shippedText?: string | null): ModelsMerge {
  const raw: unknown = doc.toJS();
  if (name === "models") return mergeModelsWithShipped(withoutConfigVersion(raw));
  if (!isOverlayVersion(name, documentConfigVersion(doc))) return { value: raw, errors: [], warnings: [] };
  const text = shippedText === undefined ? readShippedText(name) : shippedText;
  const file = getDefaultConfigPath(name) ?? getUserConfigPath(name);
  if (text === null) throw new ConfigError({ configName: name, filePath: file, kind: "missing", layer: "shipped" });
  return { value: mergeLayers(shippedEffective(name, text, file).value, withoutConfigVersion(raw), { replaceAt: replaceRule(name) }), errors: [], warnings: [] };
}

/** The plain value of `resolveConfigDocument`. */
export function configDocumentValue(name: ConfigName, doc: Document): unknown {
  return resolveConfigDocument(name, doc).value;
}

const overlayPath = (path: OverlayIssue["path"]): string => path.reduce<string>((acc, segment) => (typeof segment === "number" ? `${acc}[${segment}]` : acc === "" ? segment : `${acc}.${segment}`), "");

/** `parseConfigText` plus what the in-memory migration did (from / to version and the steps that ran). */
export function parseConfigTextWithVersion<N extends ConfigName>(name: N, text: string, filePath = configSourcePath(name), shippedText?: string | null): { value: ConfigValue<N>; migration: DocumentMigrationResult } {
  const doc = parseConfigDocument(name, text, filePath);
  const migration = migrateConfigDocument(name, doc, filePath);
  const resolved = resolveConfigDocument(name, doc, shippedText);
  if (resolved.errors.length > 0) {
    throw new ConfigError({ configName: name, filePath, kind: "schema", issues: resolved.errors.map((issue) => ({ path: overlayPath(issue.path), message: issue.message })) });
  }
  const merged = name === "models" || isOverlayVersion(name, documentConfigVersion(doc));
  return { value: validateConfigValue(name, resolved.value, filePath, merged ? doc.toJS() : undefined), migration };
}

/** Re-read the file, validate and replace the cache entry. On failure the previous cache entry is kept. */
export function reloadConfig<N extends ConfigName>(name: N): ConfigValue<N> {
  const layers = readConfigLayers(name);
  const value = deepFreeze(parseConfigLayers(name, layers));
  setEntry(name, value, layers.fingerprint);
  return value;
}

/**
 * Reload a config and say which snapshot was validated: what the "loaded" acknowledgement records, so it can never name a
 * state that did not pass. Throws like `reloadConfig`.
 */
export function reloadConfigWithFingerprint<N extends ConfigName>(name: N): { value: ConfigValue<N>; fingerprint: string } {
  const layers = readConfigLayers(name);
  const value = deepFreeze(parseConfigLayers(name, layers));
  setEntry(name, value, layers.fingerprint);
  return { value, fingerprint: layers.fingerprint };
}

function setEntry(name: ConfigName, value: unknown, fingerprint: string): void {
  if (cache.size === 0) lastRefreshAt = Date.now();
  // a good value is in the cache now: the same bad content coming back later is a new problem
  reportedBad.delete(name);
  cache.set(cacheKey(name), { value, fingerprint });
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

/** Internal: used by writeConfig and the watcher to refresh the cache with a value and the snapshot it is from. Default: the files as they are now. */
export function primeConfigCache<N extends ConfigName>(name: N, value: ConfigValue<N>, fingerprint: string = readConfigLayers(name).fingerprint): void {
  setEntry(name, deepFreeze(value), fingerprint);
}

export interface ConfigRefreshResult {
  /** Configs with a layer that changed since they were cached; the cache now holds the new value. */
  changed: ConfigName[];
  /** Configs whose changed files could not be read or validated; the last good value stays cached. */
  errors: ConfigError[];
}

/**
 * Bring every cached config in line with its file, synchronously. Long-running processes (runner, ai-worker) call
 * this at the start of each cycle and each control request, so a change made by another process (the web writing
 * preferences.yaml from the wizard or /me) is in effect for the work that follows, without waiting for the watcher's
 * debounce or poll and without depending on a hand-kept list of watched names.
 *
 * Only configs already cached are re-read (both layers, one small file read each; an uncached config is read fresh on first use).
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
    // What was read, to tell "the same bad content again" from a new one; a file that cannot be read has no fingerprint.
    let badContent = "";
    try {
      const layers = readConfigLayers(name);
      if (layers.fingerprint === hit.fingerprint) {
        reportedBad.delete(name);
        continue;
      }
      badContent = layers.fingerprint;
      const value = deepFreeze(parseConfigLayers(name, layers));
      cache.set(key, { value, fingerprint: layers.fingerprint });
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
  warnedMissingVersion.clear();
  lastRefreshAt = null;
}

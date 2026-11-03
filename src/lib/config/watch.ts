import fs from "node:fs";
import path from "node:path";

import { ConfigError } from "./errors";
import { configSourcePath, parseConfigLayers, primeConfigCache, readConfigLayers, registerConfigWatcher, type ConfigLayerTexts } from "./load";
import { getDefaultConfigPath, getPollIntervalMs, getUserConfigPath } from "./paths";
import { CONFIG_NAMES, isProfileName, type ConfigName, type ConfigValue } from "./registry";

export interface ConfigChangeEvent<N extends ConfigName = ConfigName> {
  name: N;
  filePath: string;
  value: ConfigValue<N>;
  /** The layered fingerprint of the snapshot `value` was validated from (what the "loaded" acknowledgement records). */
  fingerprint: string;
}

export interface WatchOptions {
  /** Debounce for fs.watch events, ms (default 300). */
  debounceMs?: number;
  /** Polling fallback interval, ms. Default: `JOB_RADAR_CONFIG_POLL_MS` or 5000; 0 disables polling. */
  pollMs?: number;
  /** Use fs.watch in addition to polling (default true). Polling alone is enough on Docker bind mounts. */
  fsWatch?: boolean;
  /** Called when a changed file is invalid. The last good value stays in the cache. Default: console.error. */
  onError?: (error: ConfigError) => void;
  /** How a directory is watched (default `fs.watch`). Tests pass their own: the operating system decides when its events arrive. */
  watchDirectory?: WatchDirectory;
}

/** Start watching `dir`; `onChange` gets the name of the changed file (null: the system did not say which). Throws when the directory cannot be watched. */
export type WatchDirectory = (dir: string, onChange: (filename: string | null) => void) => { close: () => void };

const fsWatchDirectory: WatchDirectory = (dir, onChange) => {
  const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => onChange(filename === null || filename === undefined ? null : String(filename)));
  watcher.on("error", () => {
    // Directory removed or watcher broke: polling keeps working.
  });
  return watcher;
};

export type ConfigTarget = ConfigName | "all" | readonly ConfigName[];

function toNames(target: ConfigTarget): ConfigName[] {
  if (target === "all") return [...CONFIG_NAMES];
  return typeof target === "string" ? [target] : [...target];
}

function defaultOnError(error: ConfigError): void {
  console.error(`[config] ${error.message}\n[config] keeping the last valid value`);
}

/**
 * Watch config files and call `onChange` with the new validated value whenever one changes.
 *
 * - fs.watch on the containing directories (survives atomic rename-writes) with a debounce, plus a
 *   polling fallback because fs.watch is unreliable on Docker bind mounts.
 * - Both layers are watched (user directory and defaults directory): the value is the shipped file with the user's file
 *   over it, so a change in either one, or a user file that appears or is deleted, gives a new value.
 * - Invalid content never throws out of the watcher: the previous value stays in the cache and
 *   `onError` is called once per distinct bad content.
 * - While at least one watcher runs, `loadConfig` does not refresh the cache on demand (see there).
 * - Returns an unsubscribe function that stops all watchers and timers.
 */
export function watchConfig(target: ConfigTarget, onChange: (event: ConfigChangeEvent) => void, options: WatchOptions = {}): () => void {
  const names = toNames(target);
  const debounceMs = options.debounceMs ?? 300;
  const pollMs = options.pollMs ?? getPollIntervalMs();
  const onError = options.onError ?? defaultOnError;

  // Last fingerprint seen per config (null = no layer readable), so each distinct content is handled once.
  const lastSeen = new Map<ConfigName, string | null>();
  for (const name of names) lastSeen.set(name, fingerprintOrNull(name));

  // A process with a watcher keeps its cache current here, so `loadConfig` does not also refresh on demand.
  const releaseWatcher = registerConfigWatcher();
  let closed = false;

  const check = (name: ConfigName): void => {
    if (closed) return;
    const filePath = configSourcePath(name);
    const previous = lastSeen.get(name) ?? null;
    let layers: ConfigLayerTexts;
    try {
      layers = readConfigLayers(name);
    } catch (err) {
      if (err instanceof ConfigError) safely(() => onError(err));
      return;
    }
    if (nothingToWatch(name, layers)) {
      if (previous !== null) {
        lastSeen.set(name, null);
        safely(() => onError(new ConfigError({ configName: name, filePath, kind: "missing" })));
      }
      return;
    }
    if (layers.fingerprint === previous) return;
    lastSeen.set(name, layers.fingerprint);
    try {
      const value = parseConfigLayers(name, layers);
      primeConfigCache(name, value, layers.fingerprint);
      safely(() => onChange({ name, filePath, value, fingerprint: layers.fingerprint }));
    } catch (err) {
      if (err instanceof ConfigError) safely(() => onError(err));
      else throw err;
    }
  };

  const timers = new Map<ConfigName, NodeJS.Timeout>();
  const schedule = (name: ConfigName): void => {
    const existing = timers.get(name);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(name);
      check(name);
    }, debounceMs);
    timer.unref();
    timers.set(name, timer);
  };

  const watchDirectory = options.watchDirectory ?? fsWatchDirectory;
  const watchers: Array<{ close: () => void }> = [];
  // Directories that could not be watched yet (e.g. profile dir not created); retried on each poll tick.
  const pendingDirs = new Map<string, Map<string, ConfigName>>();
  const attach = (dir: string, files: Map<string, ConfigName>): void => {
    try {
      const watcher = watchDirectory(dir, (filename) => {
        if (filename === null) {
          for (const n of files.values()) schedule(n);
          return;
        }
        const changed = files.get(filename);
        if (changed) schedule(changed);
      });
      watchers.push(watcher);
      pendingDirs.delete(dir);
    } catch {
      // Directory missing or fs.watch unsupported: rely on polling and retry later.
      pendingDirs.set(dir, files);
    }
  };
  if (options.fsWatch !== false) {
    const byDir = new Map<string, Map<string, ConfigName>>();
    for (const name of names) {
      const shipped = getDefaultConfigPath(name);
      for (const file of shipped === null ? [getUserConfigPath(name)] : [getUserConfigPath(name), shipped]) {
        const dir = path.dirname(file);
        const files = byDir.get(dir) ?? new Map<string, ConfigName>();
        files.set(path.basename(file), name);
        byDir.set(dir, files);
      }
    }
    for (const [dir, files] of byDir) attach(dir, files);
  }

  let poller: NodeJS.Timeout | undefined;
  if (pollMs > 0) {
    poller = setInterval(() => {
      for (const [dir, files] of [...pendingDirs]) attach(dir, files);
      for (const name of names) check(name);
    }, pollMs);
    poller.unref();
  }

  return () => {
    releaseWatcher();
    closed = true;
    for (const w of watchers) w.close();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    if (poller) clearInterval(poller);
  };
}

/** No layer to read. A profile file's template does not count: it is what a reader falls back on, not a layer of the file. */
function nothingToWatch(name: ConfigName, layers: ConfigLayerTexts): boolean {
  return layers.overlay === null && (layers.shipped === null || isProfileName(name));
}

function fingerprintOrNull(name: ConfigName): string | null {
  try {
    const layers = readConfigLayers(name);
    return nothingToWatch(name, layers) ? null : layers.fingerprint;
  } catch {
    return null;
  }
}

/** A throwing callback must not take the watcher down. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error("[config] watcher callback threw:", err instanceof Error ? err.message : err);
  }
}

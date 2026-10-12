import fs from "node:fs";
import path from "node:path";

import { ConfigError } from "./errors";
import { configSourcePath, parseConfigText, primeConfigCache, readConfigText, registerConfigWatcher } from "./load";
import { getDefaultConfigPath, getPollIntervalMs, getUserConfigPath } from "./paths";
import { CONFIG_NAMES, type ConfigName, type ConfigValue } from "./registry";

export interface ConfigChangeEvent<N extends ConfigName = ConfigName> {
  name: N;
  filePath: string;
  value: ConfigValue<N>;
  /** The file text `value` was parsed from (what `hashConfigText` should be applied to). */
  text: string;
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
}

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
 * - Both layers are watched (user directory and defaults directory), so a user file that appears or is deleted
 *   switches the value to it / back to the shipped default.
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

  // Last text seen per file (null = file absent), so each distinct content is handled once.
  const lastText = new Map<ConfigName, string | null>();
  for (const name of names) lastText.set(name, readTextOrNull(name));

  // A process with a watcher keeps its cache current here, so `loadConfig` does not also refresh on demand.
  const releaseWatcher = registerConfigWatcher();
  let closed = false;

  const check = (name: ConfigName): void => {
    if (closed) return;
    const filePath = configSourcePath(name);
    const previous = lastText.get(name) ?? null;
    let text: string;
    try {
      text = readConfigText(name);
    } catch (err) {
      if (err instanceof ConfigError && err.kind === "missing") {
        if (previous !== null) {
          lastText.set(name, null);
          safely(() => onError(err));
        }
        return;
      }
      if (err instanceof ConfigError) safely(() => onError(err));
      return;
    }
    if (text === previous) return;
    lastText.set(name, text);
    try {
      const value = parseConfigText(name, text, filePath);
      primeConfigCache(name, value, text);
      safely(() => onChange({ name, filePath, value, text }));
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

  const watchers: fs.FSWatcher[] = [];
  // Directories that could not be watched yet (e.g. profile dir not created); retried on each poll tick.
  const pendingDirs = new Map<string, Map<string, ConfigName>>();
  const attach = (dir: string, files: Map<string, ConfigName>): void => {
    try {
      const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
        if (filename === null || filename === undefined) {
          for (const n of files.values()) schedule(n);
          return;
        }
        const changed = files.get(String(filename));
        if (changed) schedule(changed);
      });
      watcher.on("error", () => {
        // Directory removed or watcher broke: polling keeps working.
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

function readTextOrNull(name: ConfigName): string | null {
  try {
    return readConfigText(name);
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

import { statSync } from "node:fs";

import { parseCodexVersion } from "./codex-version";
import { childEnv, findExecutable, makeScratchDir, runProcess, type ProcessRunner } from "./process";

/**
 * The feature names the installed Codex knows (`codex features list`), so a call can switch off every one of them
 * that is not on the benign allowlist (`codexFeaturesOff`). Read once per Codex version: the listing runs with
 * `CODEX_HOME` pointed at an empty directory (no user config, no login involved, no model call), and the version is
 * read again only when the executable file changes (an upgrade). Calls that arrive while a read is running share it.
 * Never throws: null = could not be read (a warning is logged once, the failure is not cached), the caller falls back
 * to the fixed blocklist.
 */
export type CodexFeatureLister = (command: string, env: Record<string, string | undefined>) => Promise<readonly string[] | null>;

const LIST_TIMEOUT_MS = 15_000;

/** `name  stage  enabled` rows (stage may be two words, e.g. `under development`) -> the names. */
export function parseCodexFeatureList(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split("\n")) {
    // dotted names (sub-features of removed experiments) are skipped: only plain names become `features.<name>` keys
    const match = /^([a-z0-9_]+)\s+\S.*\s(true|false)\s*$/.exec(line.trim());
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

export interface CodexFeatureListerOptions {
  /**
   * Called once per executable (and again after it changes) when the listing cannot be read and the fixed fallback
   * blocklist applies instead. Default: a warning on stderr.
   */
  onFallback?: (message: string) => void;
}

const defaultOnFallback = (message: string): void => console.warn(`WARNING: ${message}`);

export function createCodexFeatureLister(run: ProcessRunner = runProcess, options: CodexFeatureListerOptions = {}): CodexFeatureLister {
  const onFallback = options.onFallback ?? defaultOnFallback;
  /**
   * executable path + mtime -> version, and version -> feature names. Only successes are kept for good; a call that is
   * already running is shared by every caller that arrives meanwhile (one `codex` process, not one per concurrent call).
   */
  const versions = new Map<string, string>();
  const features = new Map<string, readonly string[]>();
  const versionRuns = new Map<string, Promise<string | null>>();
  const featureRuns = new Map<string, Promise<readonly string[] | null>>();
  const warned = new Set<string>();

  const exec = async (command: string, args: string[], env: Record<string, string>): Promise<string | null> => {
    const scratch = makeScratchDir("jr-codex-home");
    try {
      const result = await run({ command, args, stdin: "", cwd: scratch.dir, env: { ...env, CODEX_HOME: scratch.dir }, timeoutMs: LIST_TIMEOUT_MS });
      return result.exitCode === 0 ? result.stdout : null;
    } catch {
      return null;
    } finally {
      scratch.cleanup();
    }
  };

  /** Single in-flight run per key; the result is kept (`keep`) only when it succeeded. */
  const shared = <T>(runs: Map<string, Promise<T | null>>, key: string, work: () => Promise<T | null>, keep: (value: T) => void): Promise<T | null> => {
    const running = runs.get(key);
    if (running !== undefined) return running;
    const started = work()
      .then((value) => {
        if (value !== null) keep(value);
        return value;
      })
      .finally(() => runs.delete(key));
    runs.set(key, started);
    return started;
  };

  const fallback = (fileKey: string, resolved: string, reason: string): null => {
    if (!warned.has(fileKey)) {
      warned.add(fileKey);
      onFallback(
        `codex-cli: ${reason} (${resolved}); only the built-in list of tool features is switched off, features this Codex version added stay on. Check the installation (codex features list) and docs/ai-providers.md`,
      );
    }
    return null;
  };

  return async (command, env) => {
    const resolved = findExecutable(command, env);
    if (resolved === null) return null; // not installed: the provider reports itself unavailable, nothing is run
    let fileKey: string;
    try {
      fileKey = `${resolved}\0${statSync(resolved).mtimeMs}`;
    } catch {
      return null;
    }
    const base = childEnv(env, []);
    const version =
      versions.get(fileKey) ??
      (await shared(
        versionRuns,
        fileKey,
        async () => {
          const out = await exec(resolved, ["--version"], base);
          return out === null ? null : parseCodexVersion(out);
        },
        (value) => versions.set(fileKey, value),
      ));
    if (version === null) return fallback(fileKey, resolved, "could not read the Codex version");
    const known = features.get(version);
    if (known !== undefined) return known;
    const listed = await shared(
      featureRuns,
      version,
      async () => {
        const out = await exec(resolved, ["features", "list"], base);
        const names = out === null ? [] : parseCodexFeatureList(out);
        return names.length > 0 ? names : null;
      },
      (value) => features.set(version, value),
    );
    return listed ?? fallback(fileKey, resolved, "could not read `codex features list`");
  };
}

/** The process-wide lister (one cache for every codex-cli provider instance). */
export const defaultCodexFeatureLister: CodexFeatureLister = createCodexFeatureLister();

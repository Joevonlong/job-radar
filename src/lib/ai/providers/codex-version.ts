import { tmpdir } from "node:os";

import { childEnv, runProcess, type ProcessRunner } from "./process";

const VERSION_TIMEOUT_MS = 5_000;
const cache = new Map<string, string>();

/** `codex-cli 0.160.1` -> `0.160.1` (null when the text has no version). */
export function parseCodexVersion(output: string): string | null {
  return /codex-cli\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output)?.[1] ?? null;
}

export interface CodexVersionOptions {
  env?: Record<string, string | undefined>;
  runProcess?: ProcessRunner;
  /** Ignore the per-process cache (tests). */
  fresh?: boolean;
}

/** The installed version from `<command> --version`, cached per process; null when it cannot be read. Never throws. */
export async function readCodexVersion(command: string, options: CodexVersionOptions = {}): Promise<string | null> {
  const cached = cache.get(command);
  if (cached !== undefined && !options.fresh) return cached;
  const run = options.runProcess ?? runProcess;
  try {
    const result = await run({
      command,
      args: ["--version"],
      stdin: "",
      cwd: tmpdir(),
      env: childEnv(options.env ?? process.env, ["CODEX_HOME"]),
      timeoutMs: VERSION_TIMEOUT_MS,
    });
    const version = parseCodexVersion(result.stdout);
    if (version !== null) cache.set(command, version);
    return version;
  } catch {
    return null;
  }
}

/** The numeric `[major, minor, patch]` of a version (a pre-release suffix is ignored); null when it is not X.Y.Z. */
function versionParts(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True when `installed` is older than `minimum`. An unreadable version on either side is not "older". */
export function isCodexOlderThan(installed: string | null, minimum: string): boolean {
  if (installed === null) return false;
  const have = versionParts(installed);
  const need = versionParts(minimum);
  if (have === null || need === null) return false;
  for (let i = 0; i < 3; i += 1) {
    if ((have[i] ?? 0) !== (need[i] ?? 0)) return (have[i] ?? 0) < (need[i] ?? 0);
  }
  return false;
}

/** The warning for an installed version below the minimum; null when it is equal or newer, or unknown. */
export function codexVersionWarning(installed: string | null, minimum: string): string | null {
  if (installed === null || !isCodexOlderThan(installed, minimum)) return null;
  return `Codex ${installed} is older than the minimum ${minimum} that codex-cli needs (codex exec --ignore-user-config / --ignore-rules); update Codex, see docs/ai-providers.md`;
}

import { createLogger, type LoggerOptions } from "@/lib/channels/logger";
import type { ChannelLogger } from "@/lib/channels/types";
import { ConfigError } from "@/lib/config/errors";
import { loadConfig } from "@/lib/config/load";
import { DEFAULT_CONFIG_POLL_MS, getPollIntervalMs } from "@/lib/config/paths";
import { parseLogLevelEnv } from "@/lib/env";

import { DEFAULT_LOG_LEVEL, LOG_LEVELS, type LogLevel } from "./levels";

/**
 * The log level of a process: `JOB_RADAR_LOG_LEVEL` > schedule.yaml `logging.level` > `info`.
 *
 * Only the process entry points and the loggers they hand out import this module (never the config modules or
 * `channels/logger.ts`, which would close an import cycle through the schedule schema). Nothing is read when the module
 * loads: the first record that is written asks for the level.
 *
 * Cost: the resolved level is remembered, and schedule.yaml is asked again (through the normal `loadConfig`, i.e. the
 * cache the watcher and the on-demand refresh keep current) at most once per config poll interval; a non-positive
 * interval (`JOB_RADAR_CONFIG_POLL_MS=0`) uses the default interval instead, so a record never touches the disk in the
 * steady state.
 *
 * Config cases: never loaded (file unreadable or invalid) -> `info`, one warning, retried each interval until it loads;
 * loaded, then broken -> the loader keeps the last valid file, so its level stays until a restart; fixed -> the new level
 * within one interval of the cache picking it up.
 */
interface ResolverState {
  /** `JOB_RADAR_LOG_LEVEL` once parsed (`undefined` = unset or invalid); `null` until the first record asks. */
  env: LogLevel | undefined | null;
  /** The level last taken from the config (or the default). */
  level: LogLevel;
  /** Whether schedule.yaml has ever loaded in this process. */
  loaded: boolean;
  /** When the config was last asked (`Date.now()`), and when it is asked next. */
  checkedAt: number | null;
  dueAt: number;
  warnedEnv: boolean;
  warnedConfig: boolean;
}

function freshState(): ResolverState {
  return { env: null, level: DEFAULT_LOG_LEVEL, loaded: false, checkedAt: null, dueAt: 0, warnedEnv: false, warnedConfig: false };
}

let state = freshState();

/** How long a level taken from the config is used before it is asked again. */
function recheckIntervalMs(): number {
  const interval = getPollIntervalMs();
  return interval > 0 ? interval : DEFAULT_CONFIG_POLL_MS;
}

/** The resolver's own diagnostics go straight to the console (never through a logger that asks this resolver). */
function warnEnvOnce(): void {
  if (state.warnedEnv) return;
  state.warnedEnv = true;
  console.warn(`[logging] JOB_RADAR_LOG_LEVEL is not one of ${LOG_LEVELS.join(", ")}; it is ignored`);
}

function warnConfigOnce(error: unknown): void {
  if (state.warnedConfig) return;
  state.warnedConfig = true;
  const reason = error instanceof ConfigError ? error.message : error instanceof Error ? error.name : "unexpected error";
  console.warn(`[logging] could not read logging.level from schedule.yaml, logging at ${DEFAULT_LOG_LEVEL} until it can be read: ${reason}`);
}

/** The level this process logs at now. Never throws. */
export function resolveLogLevel(): LogLevel {
  if (state.env === null) {
    const parsed = parseLogLevelEnv();
    state.env = parsed.level;
    if (parsed.invalid) warnEnvOnce();
  }
  if (state.env !== undefined) return state.env;

  const now = Date.now();
  // a clock that went back counts as due, so a jump cannot freeze the level
  if (state.checkedAt !== null && now < state.dueAt && now >= state.checkedAt) return state.level;
  // set before reading, so a record written while the config loads (re-entrant) gets the current level
  state.checkedAt = now;
  state.dueAt = now + recheckIntervalMs();
  try {
    state.level = loadConfig("schedule").logging.level;
    state.loaded = true;
  } catch (error) {
    // after one success the loader keeps the last valid value and does not throw; if it ever does, keep the level we have
    if (!state.loaded) warnConfigOnce(error);
  }
  return state.level;
}

/** Test seam: forget the parsed variable, the remembered level and the warnings. */
export function resetLogLevelResolver(): void {
  state = freshState();
}

/**
 * The logger of a process (web modules, runner, ai-worker, `pnpm cycle:run`): `createLogger` with the level of
 * `resolveLogLevel`, followed at run time by it and by its children.
 */
export function createProcessLogger(options: Omit<LoggerOptions, "minLevel"> = {}): ChannelLogger {
  return createLogger({ ...options, minLevel: resolveLogLevel });
}

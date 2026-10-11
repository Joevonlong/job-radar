import { firstConfigProblem } from "./errors";
import { refreshConfigCache } from "./load";
import type { ConfigName } from "./registry";

interface RefreshLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Make the cached configs match their files before a unit of work (a cycle, a control request) starts, and log
 * what changed. Never throws for a bad file: the last good value stays, as with the watcher. Returns the changed names.
 */
export function freshenConfig(logger?: RefreshLogger): ConfigName[] {
  const { changed, errors } = refreshConfigCache();
  if (changed.length > 0) logger?.info("config reloaded", { configs: changed });
  for (const error of errors) logger?.warn("ignoring invalid config, keeping the last valid value", { config: error.configName, error: firstConfigProblem(error) });
  return changed;
}

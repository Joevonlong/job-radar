/** Web side: breakdown.yaml read fresh on every call (the web app has no config watcher). Server only. */
import { ConfigError, firstConfigProblem, reloadConfig, type BreakdownConfig } from "@/lib/config";

export type BreakdownSettingsState = { state: "ok"; config: BreakdownConfig } | { state: "error"; problem: string };

export function readBreakdownSettings(): BreakdownSettingsState {
  try {
    return { state: "ok", config: reloadConfig("breakdown") };
  } catch (error) {
    if (error instanceof ConfigError) return { state: "error", problem: firstConfigProblem(error) };
    throw error;
  }
}

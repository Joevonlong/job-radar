/** Web side: salary.yaml read fresh on every page load (the web app has no config watcher). Server only. */
import { ConfigError, firstConfigProblem, reloadConfig, type SalaryConfig } from "@/lib/config";

export type SalarySettingsState = { state: "ok"; config: SalaryConfig } | { state: "error"; problem: string };

export function readSalarySettings(): SalarySettingsState {
  try {
    return { state: "ok", config: reloadConfig("salary") };
  } catch (error) {
    if (error instanceof ConfigError) return { state: "error", problem: firstConfigProblem(error) };
    throw error;
  }
}

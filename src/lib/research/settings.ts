/** Web side: research.yaml read fresh on every page load (the web app has no config watcher). Server only. */
import { ConfigError, firstConfigProblem, reloadConfig, type ResearchConfig } from "@/lib/config";

export type ResearchSettingsState = { state: "ok"; config: ResearchConfig } | { state: "error"; problem: string };

export function readResearchSettings(): ResearchSettingsState {
  try {
    return { state: "ok", config: reloadConfig("research") };
  } catch (error) {
    if (error instanceof ConfigError) return { state: "error", problem: firstConfigProblem(error) };
    throw error;
  }
}

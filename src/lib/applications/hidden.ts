/**
 * Server side of the status / category visibility: what `ui.yaml` hides. A ui.yaml that cannot be read hides
 * nothing, so a broken file never makes a status unreachable (the advanced editor can still repair it).
 */
import { loadConfig, reloadConfig } from "@/lib/config";

export interface HiddenSettings {
  statuses: readonly string[];
  workplaces: readonly string[];
  contracts: readonly string[];
}

const NOTHING: HiddenSettings = { statuses: [], workplaces: [], contracts: [] };

function pick(read: () => ReturnType<typeof loadConfig<"ui">>): HiddenSettings {
  try {
    const ui = read();
    return { statuses: ui.applications.hidden_statuses, workplaces: ui.filters.hidden_workplaces, contracts: ui.filters.hidden_contracts };
  } catch {
    return NOTHING;
  }
}

/** For pages: the file is read fresh (the web process has no config watcher, and route bundles do not share a cache). */
export function readHiddenSettings(): HiddenSettings {
  return pick(() => reloadConfig("ui"));
}

/** For the runner (its watcher keeps the cache current). */
export function loadHiddenSettings(): HiddenSettings {
  return pick(() => loadConfig("ui"));
}

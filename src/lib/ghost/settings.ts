/**
 * The owner's switches of the ghost job check: ui.yaml `job_checks.ghost` (on / off, trusted companies). Read from the file each
 * time, like the visa check's: the web app has no config watcher, and a hand edit of ui.yaml must show on the next page load.
 */
import { reloadConfig } from "@/lib/config";
import type { PipelineConfig } from "@/lib/config/schemas/pipeline";
import { GHOST_UI_DEFAULTS, type UiConfig } from "@/lib/config/schemas/ui";
import { loadPipeline } from "@/lib/market/effective";
import { resolveCompanyName } from "@/lib/pipeline/company";

export interface GhostSettings {
  enabled: boolean;
  trusted_companies: string[];
}

/** ui.yaml `job_checks.ghost`; when ui.yaml cannot be read the defaults apply (off: nothing is computed or shown). */
export function readGhostSettings(load: () => { job_checks: Pick<UiConfig["job_checks"], "ghost"> } = () => reloadConfig("ui")): GhostSettings {
  try {
    const ghost = load().job_checks.ghost;
    return { enabled: ghost.enabled, trusted_companies: [...ghost.trusted_companies] };
  } catch {
    return { ...GHOST_UI_DEFAULTS, trusted_companies: [] };
  }
}

/** Whether the check runs in the cycle and the pages show it (ui.yaml `job_checks.ghost.enabled`). */
export function ghostEnabled(): boolean {
  return readGhostSettings().enabled;
}

/** The trusted companies as `companies.name_norm` keys (aliases applied, as the pipeline stores them), sorted and unique. */
export function trustedCompanyKeys(names: readonly string[], pipeline: PipelineConfig): string[] {
  const keys = names.map((name) => resolveCompanyName(name, pipeline).nameNorm).filter((key) => key !== "");
  return [...new Set(keys)].sort();
}

/**
 * ui.yaml `trusted_companies` as `companies.name_norm` keys, for the pages: their marks are hidden at once, before the next cycle
 * stores "none". Empty when the config cannot be read (the stored results show as they are).
 */
export function ghostTrustedKeys(load: () => PipelineConfig = loadPipeline, settings: () => GhostSettings = () => readGhostSettings()): string[] {
  const names = settings().trusted_companies;
  if (names.length === 0) return [];
  try {
    return trustedCompanyKeys(names, load());
  } catch {
    return [];
  }
}

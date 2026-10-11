import { ConfigError, loadConfig } from "@/lib/config";
import type { TrapsConfig } from "@/lib/config/schemas/traps";

/**
 * traps.yaml, or null when it cannot be read (missing, invalid): the feature then stays out of the way (nothing is scanned,
 * nothing cleaned, nothing shown) instead of breaking the page or the AI task that asked. Other errors are thrown.
 */
export function readTrapsSettings(load: () => TrapsConfig = () => loadConfig("traps")): TrapsConfig | null {
  try {
    return load();
  } catch (error) {
    if (error instanceof ConfigError) return null;
    throw error;
  }
}

/** Whether the pages show the trap badge, filter, panel and banner (traps.yaml `enabled`; an unreadable file counts as off). */
export function trapsEnabled(): boolean {
  return readTrapsSettings()?.enabled === true;
}

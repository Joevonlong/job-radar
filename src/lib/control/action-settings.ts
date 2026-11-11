import { ConfigError, reloadConfig, type AiConfig } from "@/lib/config";
import { logActionFailure } from "@/lib/logging/action-failure";
import { readResearchSettings } from "@/lib/research/settings";
import { readSalarySettings } from "@/lib/salary/settings";

/** The web buttons and agent actions read the same fresh settings, including the same config-error fallback. */
function readActionAi(): AiConfig | null {
  try {
    return reloadConfig("ai");
  } catch (error) {
    logActionFailure("readActionAi", error);
    if (error instanceof ConfigError) return null;
    throw error;
  }
}

export function readSalaryActionSettings() {
  const settings = readSalarySettings();
  return { salary: settings.state === "ok" ? settings.config : null, ai: readActionAi() };
}

export function readCompanyActionSettings() {
  const settings = readResearchSettings();
  return { research: settings.state === "ok" ? settings.config : null, ai: readActionAi() };
}

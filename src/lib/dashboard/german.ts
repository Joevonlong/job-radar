import { loadConfig, type MeConfig } from "@/lib/config";
import type { GermanLevel } from "@/lib/domain/types";
import { loadMarket } from "@/lib/market/resolve";
import { penalizedLanguageLevels, userLanguageLabel } from "@/lib/scoring/german";

/** The market's local language when its step is on, else null (nothing to hide or show). */
function localLanguage(): string | null {
  try {
    return loadMarket().language?.code ?? null;
  } catch {
    return null;
  }
}

/**
 * Levels the "hide German-required" quick filter hides: the German levels above the user's own
 * (me.yaml) that cost points in the scoring (ai.yaml `scoring.german_penalty`). When me.yaml cannot
 * be read every level that costs points is hidden.
 */
export function germanLevelsToHide(): GermanLevel[] {
  let me: MeConfig | null = null;
  try {
    me = loadConfig("me");
  } catch {
    me = null;
  }
  return penalizedLanguageLevels(me, loadConfig("ai").scoring.language_penalty, localLanguage());
}

/** The user's German from me.yaml for display ("B1", "native"), or null when none is listed or me.yaml cannot be read. */
export function userGermanLabelOrNull(): string | null {
  try {
    const language = localLanguage();
    if (language === null) return null;
    const label = userLanguageLabel(loadConfig("me"), language);
    return label === "none" ? null : label;
  } catch {
    return null;
  }
}

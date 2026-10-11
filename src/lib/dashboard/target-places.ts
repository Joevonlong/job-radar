import { loadConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";

import { targetPlaceNames } from "./apply";

/** The wanted cities (preferences.yaml, with spellings and metro towns from pipeline.yaml) for `pickApplyTarget`; none when a file cannot be read. */
export function loadTargetPlaces(): string[] {
  try {
    return targetPlaceNames(loadConfig("preferences"), loadPipeline().filter);
  } catch {
    return [];
  }
}

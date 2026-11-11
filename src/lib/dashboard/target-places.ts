import { loadConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import { placeDictionary } from "@/lib/market/geo";

import { targetPlaceNames } from "./apply";

/** The wanted cities (preferences.yaml, with spellings from pipeline.yaml and the place dictionary, and metro towns) for `pickApplyTarget`; none when a file cannot be read. */
export function loadTargetPlaces(): string[] {
  try {
    return targetPlaceNames(loadConfig("preferences"), loadPipeline(), placeDictionary());
  } catch {
    return [];
  }
}

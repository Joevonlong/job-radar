import { loadConfig, reloadConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import { placeDictionary } from "@/lib/market/geo";

import { queryPlaces, type QueryPlaces } from "./query";

/** preferences.yaml as it is now; a file that went bad keeps its last good value, so one bad hand edit doesn't stop the searches. */
function currentPreferences(): ReturnType<typeof reloadConfig<"preferences">> {
  try {
    return reloadConfig("preferences");
  } catch {
    return loadConfig("preferences");
  }
}

/** The location settings, for building queries. Throws when preferences.yaml was never readable or the market cannot be read. */
export function loadQueryPlaces(): QueryPlaces {
  return queryPlaces(currentPreferences(), loadPipeline(), placeDictionary());
}

import { reloadConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";

import { queryPlaces, type QueryPlaces } from "./query";

/** The location settings as they are now, for building queries. Throws when preferences.yaml or the market cannot be read. */
export function loadQueryPlaces(): QueryPlaces {
  return queryPlaces(reloadConfig("preferences"), loadPipeline());
}

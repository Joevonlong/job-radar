import { parseConfigText, readConfigText } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import { listJobCityRows, type Db } from "@/lib/db";

import { buildCityGroups, locationSearchTerms, type CityGroup } from "./city-groups";

/** The target cities of preferences.yaml; none when the file cannot be read (the dropdown then has no "target" group). */
function targetCities(): string[] {
  try {
    return [...parseConfigText("preferences", readConfigText("preferences")).locations];
  } catch {
    return [];
  }
}

/** The city dropdown of /jobs: the cities of the stored locations, grouped (see `buildCityGroups`). */
export async function loadCityGroups(db: Db): Promise<CityGroup[]> {
  const rows = await listJobCityRows(db);
  const pipeline = loadPipeline();
  return buildCityGroups(rows, { targets: targetCities(), filter: pipeline.filter, market: pipeline.market });
}

/** The spellings of a free-text search that should also match the location field ("München" -> Munich, Muenchen). */
export function searchLocationTerms(q: string | null | undefined): string[] {
  if (!q) return [];
  const pipeline = loadPipeline();
  return locationSearchTerms(q, pipeline.filter.city_aliases, pipeline.market.transliterations);
}

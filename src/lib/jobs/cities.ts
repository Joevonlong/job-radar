import { parseConfigText, readProfileText } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import { listJobCityRows, type Db } from "@/lib/db";

import { buildCityGroups, type CityGroup } from "./city-groups";

/** The target cities of preferences.yaml; none when the file cannot be read (the dropdown then has no "target" group). */
function targetCities(): string[] {
  try {
    return [...parseConfigText("preferences", readProfileText("preferences")).locations];
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

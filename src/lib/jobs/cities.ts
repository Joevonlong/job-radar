import { wantedLocations } from "@/lib/market/places";
import { parseConfigText, readProfileText } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import { listJobCityRows, type Db } from "@/lib/db";

import { buildCityGroups, type CityGroup } from "./city-groups";

/** The target cities of preferences.yaml and which is home; none when the file cannot be read (the dropdown then has no "target" group). */
function targetCities(): { targets: string[]; homeCity?: string } {
  try {
    const preferences = parseConfigText("preferences", readProfileText("preferences"));
    return { targets: wantedLocations(preferences), homeCity: preferences.home_city };
  } catch {
    return { targets: [] };
  }
}

/** The city dropdown of /jobs: the cities of the stored locations, grouped (see `buildCityGroups`). */
export async function loadCityGroups(db: Db): Promise<CityGroup[]> {
  const rows = await listJobCityRows(db);
  const pipeline = loadPipeline();
  return buildCityGroups(rows, { ...targetCities(), filter: pipeline.filter, market: pipeline.market });
}

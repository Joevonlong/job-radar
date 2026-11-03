import { isScalar, type Document } from "yaml";

import type { ConfigMigration } from "../types";
import { mapAt } from "../edit";

/** Keys of `sources.stepstone` that no longer mean anything: the search URL carries no radius and is never paged. */
const REMOVED = ["radius_km", "max_pages"] as const;

/**
 * sources.yaml 8 -> 9: StepStone's robots.txt only permits a search URL with a single `q=` parameter, so the channel no longer sends
 * `radius`, `sort`, `ag`, `wfh` or `page`. `sources.stepstone.radius_km` and `max_pages` are removed (their trailing comments go with
 * them). `sources.xing` keeps both. No-op when the block or the keys are missing.
 */
export const sources009: ConfigMigration = {
  from: 8,
  to: 9,
  description: "sources.stepstone: removes radius_km and max_pages (robots.txt permits only a search URL with a single q= parameter)",
  migrate(doc: Document) {
    const stepstone = mapAt(doc, ["sources", "stepstone"]);
    if (stepstone === null) return;
    for (const key of REMOVED) {
      const index = stepstone.items.findIndex((pair) => isScalar(pair.key) && pair.key.value === key);
      if (index !== -1) stepstone.items.splice(index, 1);
    }
  },
};

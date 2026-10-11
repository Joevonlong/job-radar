import type { ConfigMigration } from "../types";
import { insertAfter, renameKey } from "../edit";
import { REMOTE_LOCATION_RENAMES } from "../legacy-market";

/** The `remote_locations` blocks of sources.yaml (paths). */
const REMOTE_BLOCKS: ReadonlyArray<readonly string[]> = [
  ["linkedin", "brightdata", "remote_locations"],
  ["linkedin", "apify", "remote_locations"],
  ["linkedin", "session", "site", "remote_locations"],
  ["jobspy", "remote_location"],
];

/** The channels that only serve Germany (the job boards of the German market). */
const GERMAN_CHANNELS = ["arbeitsagentur", "stepstone", "xing"] as const;

/**
 * sources.yaml 1 -> 2: remote location keys follow the new remote scope kinds; the German job boards are marked
 * `markets: [DE]`; the country parameters keep their values.
 */
export const sources002: ConfigMigration = {
  from: 1,
  to: 2,
  description: "market packs: remote_locations keys eu_hire_in_de -> home_country, eu_any -> region; arbeitsagentur, stepstone, xing get markets: [DE]",
  migrate(doc) {
    for (const block of REMOTE_BLOCKS) for (const [from, to] of REMOTE_LOCATION_RENAMES) renameKey(doc, block, from, to);
    for (const id of GERMAN_CHANNELS) insertAfter(doc, ["sources", id], "enabled", "markets", ["DE"], "只在这些市场（本国 ISO 代码）运行；其他市场下跳过，不算失败");
  },
};

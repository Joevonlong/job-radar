import { isMap, isScalar, isSeq, type Document, type Node } from "yaml";

import type { ConfigMigration } from "../types";
import { mapAt } from "../edit";

/** Where the new block goes: after the other board-discovery channels (at the end of `sources` when none of them is there). */
const AFTER = ["brave", "tavily"] as const;

const COMMENT = [
  " Berlin Design Network: board discovery only, no postings, added by the config update. Reads the job list of berlin-design-network.org/jobs",
  " (one page, no key, no login) and offers the company boards its apply links point at (Greenhouse, Lever, Ashby, Personio) as candidates on",
  " /sources/registry. The list holds titles, company names and links only, so there is nothing to store. The site has no terms page and robots.txt",
  " allows the path; one request a day. Off by default: it lists design and creative employers in Berlin, which is noise unless you look for such",
  " roles. Set enabled: true to use it.",
].join("\n");

/**
 * sources.yaml 5 -> 6: a new channel, `sources.berlin_design_network` (board discovery from the Berlin Design Network job list),
 * switched OFF like the shipped default. No-op when the block exists (or the file has no `sources` mapping: validation reports that).
 */
export const sources006: ConfigMigration = {
  from: 5,
  to: 6,
  description: "new channel sources.berlin_design_network (board discovery from the Berlin Design Network job list, markets: [DE], off by default)",
  migrate(doc: Document) {
    const sources = mapAt(doc, ["sources"]);
    if (sources === null || sources.has("berlin_design_network")) return;
    const block = doc.createNode({
      enabled: false,
      markets: ["DE"],
      monthly_budget_usd: 0,
      throttle: { min_delay_ms: 1000, max_delay_ms: 3000 },
      max_results: 100,
      base_url: "https://berlin-design-network.org",
      user_agent: "JobRadar/2 (self-hosted job tracker)",
      interval_hours: 24,
    });
    if (isMap(block)) {
      const markets = block.get("markets", true) as Node | undefined;
      if (isSeq(markets)) markets.flow = true;
      const throttle = block.get("throttle", true);
      if (isMap(throttle)) throttle.flow = true;
    }
    const pair = doc.createPair("berlin_design_network", block);
    if (isScalar(pair.key)) pair.key.commentBefore = COMMENT;
    const index = AFTER.map((key) => sources.items.findIndex((item) => isScalar(item.key) && item.key.value === key)).find((i) => i >= 0);
    if (index === undefined) sources.items.push(pair);
    else sources.items.splice(index + 1, 0, pair);
  },
};

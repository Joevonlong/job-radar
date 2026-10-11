import { isMap, isScalar, isSeq, type Document, type Node } from "yaml";

import type { ConfigMigration } from "../types";
import { mapAt, valueAt } from "../edit";

/** Where the new block goes: after the other German job boards (at the end of `sources` when none of them is there). */
const AFTER = ["xing", "stepstone", "arbeitsagentur"] as const;

/** The exclude terms of the shipped default, used when the user's greenhouse prefilter has none to copy. */
const DEFAULT_EXCLUDE_TERMS = ["Werkstudent", "Working Student", "Intern", "Internship", "Praktikum", "Praktikant"];

const COMMENT = [
  " Arbeitnow: free public Job Board API (no key, no login), added by the config update.",
  " Terms (arbeitnow.com/terms, section 11): provided as is, can be withdrawn at any time, platforms using it link back to arbeitnow.com.",
  " Don't mirror or republish the collected postings (section 2.1.5). The API takes no keywords or places: each run reads the newest",
  " pages of the whole board and keeps titles that pass title_prefilter (copied from your greenhouse prefilter). enabled: false switches it off.",
].join("\n");

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");

/** Short lists and the throttle in flow style (`[DE]`, `{ min_delay_ms: 1000, ... }`), like the shipped file. */
function flowStyle(node: Node | null | undefined): void {
  if (isSeq(node)) node.flow = true;
}

/**
 * sources.yaml 2 -> 3: a new channel, `sources.arbeitnow` (the free Arbeitnow board API), switched on for the German market like
 * the shipped default. Its title prefilter terms are copied from the user's greenhouse prefilter, so the user's own exclusions
 * apply to it too. No-op when the block exists (or the file has no `sources` mapping: validation reports that).
 */
export const sources003: ConfigMigration = {
  from: 2,
  to: 3,
  description: "new channel sources.arbeitnow (free Arbeitnow board API, markets: [DE]); its title prefilter copies greenhouse's",
  migrate(doc: Document) {
    const sources = mapAt(doc, ["sources"]);
    if (sources === null || sources.has("arbeitnow")) return;
    const include = valueAt(doc, ["sources", "greenhouse", "title_prefilter", "include_terms"]);
    const exclude = valueAt(doc, ["sources", "greenhouse", "title_prefilter", "exclude_terms"]);
    const block = doc.createNode({
      enabled: true,
      markets: ["DE"],
      monthly_budget_usd: 0,
      throttle: { min_delay_ms: 1000, max_delay_ms: 3000 },
      max_results: 100,
      base_url: "https://www.arbeitnow.com",
      user_agent: "JobRadar/2 (self-hosted job tracker)",
      max_pages: 8,
      title_prefilter: {
        enabled: true,
        include_terms: isStringList(include) ? include : [],
        exclude_terms: isStringList(exclude) ? exclude : DEFAULT_EXCLUDE_TERMS,
      },
    });
    if (isMap(block)) {
      flowStyle(block.get("markets", true) as Node | undefined);
      const throttle = block.get("throttle", true);
      if (isMap(throttle)) throttle.flow = true;
      const prefilter = block.get("title_prefilter", true);
      if (isMap(prefilter)) {
        flowStyle(prefilter.get("include_terms", true) as Node | undefined);
        flowStyle(prefilter.get("exclude_terms", true) as Node | undefined);
      }
    }
    const pair = doc.createPair("arbeitnow", block);
    if (isScalar(pair.key)) pair.key.commentBefore = COMMENT;
    const index = AFTER.map((key) => sources.items.findIndex((item) => isScalar(item.key) && item.key.value === key)).find((i) => i >= 0);
    if (index === undefined) sources.items.push(pair);
    else sources.items.splice(index + 1, 0, pair);
  },
};

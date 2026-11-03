import { isMap, isScalar, isSeq, type Document, type Node } from "yaml";

import type { ConfigMigration } from "../types";
import { mapAt, valueAt } from "../edit";

/** Where the new block goes: after the other German job boards (at the end of `sources` when none of them is there). */
const AFTER = ["arbeitnow", "xing", "stepstone", "arbeitsagentur"] as const;

/** The exclude terms of the shipped default, used when the user's greenhouse prefilter has none to copy. */
const DEFAULT_EXCLUDE_TERMS = ["Werkstudent", "Working Student", "Intern", "Internship", "Praktikum", "Praktikant"];

const COMMENT = [
  " Handpicked Berlin: the public job index behind handpickedberlin.com/jobs (a static JSON file, no key, no login), added by the config update:",
  " the last ~30 days of postings in Berlin, Munich, Hamburg and German remote, each with the employer's own link. The site publishes no terms",
  " (only an imprint and a privacy page). Keep the request rate low, don't mirror or republish the data, and switch the channel off if the site asks.",
  " Off by default for that reason: set enabled: true to use it. Each run reads the index once and keeps postings in your places (search.yaml locations)",
  " that pass title_prefilter (copied from your greenhouse prefilter). discover_boards also offers the company boards behind matching postings as",
  " candidates on /sources/registry.",
].join("\n");

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");

/** Short lists and the throttle in flow style (`[DE]`, `{ min_delay_ms: 1000, ... }`), like the shipped file. */
function flowStyle(node: Node | null | undefined): void {
  if (isSeq(node)) node.flow = true;
}

/**
 * sources.yaml 4 -> 5: a new channel, `sources.handpicked` (the Handpicked Berlin job index), switched OFF like the shipped
 * default (the site publishes no terms). Its title prefilter terms are copied from the user's greenhouse prefilter, so the
 * user's own exclusions apply to it too. No-op when the block exists (or the file has no `sources` mapping: validation reports that).
 */
export const sources005: ConfigMigration = {
  from: 4,
  to: 5,
  description: "new channel sources.handpicked (Handpicked Berlin job index, markets: [DE], off by default); its title prefilter copies greenhouse's",
  migrate(doc: Document) {
    const sources = mapAt(doc, ["sources"]);
    if (sources === null || sources.has("handpicked")) return;
    const include = valueAt(doc, ["sources", "greenhouse", "title_prefilter", "include_terms"]);
    const exclude = valueAt(doc, ["sources", "greenhouse", "title_prefilter", "exclude_terms"]);
    const block = doc.createNode({
      enabled: false,
      markets: ["DE"],
      monthly_budget_usd: 0,
      throttle: { min_delay_ms: 1000, max_delay_ms: 3000 },
      max_results: 100,
      base_url: "https://handpickedberlin.com",
      user_agent: "JobRadar/2 (self-hosted job tracker)",
      max_age_days: 14,
      max_details_per_run: 30,
      skip_known_boards: true,
      discover_boards: { enabled: true, interval_hours: 24, require_title_match: true },
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
    const pair = doc.createPair("handpicked", block);
    if (isScalar(pair.key)) pair.key.commentBefore = COMMENT;
    const index = AFTER.map((key) => sources.items.findIndex((item) => isScalar(item.key) && item.key.value === key)).find((i) => i >= 0);
    if (index === undefined) sources.items.push(pair);
    else sources.items.splice(index + 1, 0, pair);
  },
};

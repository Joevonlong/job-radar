import { isMap, isScalar, isSeq, type Document, type Node } from "yaml";

import type { ConfigMigration } from "../types";
import { mapAt, valueAt } from "../edit";

/** Where the new block goes: after the other German job boards (at the end of `sources` when none of them is there). */
const AFTER = ["arbeitnow", "xing", "stepstone", "arbeitsagentur"] as const;

/** The exclude terms of the shipped default, used when the user's greenhouse prefilter has none to copy. */
const DEFAULT_EXCLUDE_TERMS = ["Werkstudent", "Working Student", "Intern", "Internship", "Praktikum", "Praktikant"];

const COMMENT = [
  " Berlin Startup Jobs: the public WordPress REST API behind berlinstartupjobs.com (no key, no login), added by the config update: about 140",
  " postings of Berlin startups, many of them small companies that take applications by e-mail only and are on no ATS. The site has no visitor",
  " terms (the employer terms say third parties may read and reuse the listings), robots.txt allows /wp-json/, and a run sends about 4 requests.",
  " The jobs' copyright is the employers': don't mirror or republish the collected postings. The whole board is read each run and titles must pass",
  " title_prefilter (copied from your greenhouse prefilter). enabled: false switches it off.",
].join("\n");

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");

/** Short lists and the throttle in flow style (`[DE]`, `{ min_delay_ms: 1000, ... }`), like the shipped file. */
function flowStyle(node: Node | null | undefined): void {
  if (isSeq(node)) node.flow = true;
}

/**
 * sources.yaml 6 -> 7: a new channel, `sources.berlinstartupjobs` (the Berlin Startup Jobs board), switched on for the German market
 * like the shipped default. Its title prefilter terms are copied from the user's greenhouse prefilter, so the user's own exclusions
 * apply to it too. No-op when the block exists (or the file has no `sources` mapping: validation reports that).
 */
export const sources007: ConfigMigration = {
  from: 6,
  to: 7,
  description: "new channel sources.berlinstartupjobs (Berlin Startup Jobs board, markets: [DE]); its title prefilter copies greenhouse's",
  migrate(doc: Document) {
    const sources = mapAt(doc, ["sources"]);
    if (sources === null || sources.has("berlinstartupjobs")) return;
    const include = valueAt(doc, ["sources", "greenhouse", "title_prefilter", "include_terms"]);
    const exclude = valueAt(doc, ["sources", "greenhouse", "title_prefilter", "exclude_terms"]);
    const block = doc.createNode({
      enabled: true,
      markets: ["DE"],
      monthly_budget_usd: 0,
      throttle: { min_delay_ms: 1000, max_delay_ms: 2000 },
      max_results: 100,
      base_url: "https://berlinstartupjobs.com",
      user_agent: "JobRadar/2 (self-hosted job tracker)",
      per_page: 100,
      max_pages: 5,
      skip_expired: true,
      max_age_days: 90,
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
    const pair = doc.createPair("berlinstartupjobs", block);
    if (isScalar(pair.key)) pair.key.commentBefore = COMMENT;
    const index = AFTER.map((key) => sources.items.findIndex((item) => isScalar(item.key) && item.key.value === key)).find((i) => i >= 0);
    if (index === undefined) sources.items.push(pair);
    else sources.items.splice(index + 1, 0, pair);
  },
};

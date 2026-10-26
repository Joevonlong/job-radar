import { isMap, type Document } from "yaml";

import { insertAfter, mapAt, seqAt, valueAt } from "../edit";
import type { ConfigMigration } from "../types";

const OLD_CASCADE = ["linkedin-brightdata", "linkedin-apify", "linkedin-session", "linkedin-guest"];

/** sources.yaml 3 -> 4: add Monid with budget headroom, preserving user blocks, cascade choices and comments. */
export const sources004: ConfigMigration = {
  from: 3,
  to: 4,
  description: "new LinkedIn fallback linkedin.monid; insert after Apify only in the previous default cascade",
  migrate(doc: Document) {
    const linkedin = mapAt(doc, ["linkedin"]);
    if (linkedin === null || linkedin.has("monid")) return;
    const cap = valueAt(doc, ["paid_total_monthly_budget_usd"]);
    // Invalid or missing global budgets are still reported by schema validation.
    const budget = typeof cap === "number" && Number.isFinite(cap) && cap >= 0 ? Math.min(5, cap) : 0;
    const cascade = seqAt(doc, ["linkedin", "cascade"]);
    const order = valueAt(doc, ["linkedin", "cascade"]);
    const insertIntoCascade = cascade !== null && Array.isArray(order) && order.length === OLD_CASCADE.length && order.every((item, index) => item === OLD_CASCADE[index]);
    if (insertIntoCascade) cascade.items.splice(2, 0, doc.createNode("linkedin-monid"));
    insertAfter(doc, ["linkedin"], "apify", "monid", {
      enabled: insertIntoCascade,
      monthly_budget_usd: budget,
      throttle: { min_delay_ms: 1000, max_delay_ms: 3000 },
      max_results: 300,
      api_base_url: "https://api.monid.ai",
      provider: "apify",
      endpoint: "/harvestapi/linkedin-job-search",
      price_per_1k_usd: 1,
      flat_fee_usd: 0.001,
      poll_interval_ms: 5000,
      timeout_ms: 300000,
      stop_grace_ms: 60000,
      country_name: "",
      remote_locations: { worldwide: "Worldwide" },
      date_posted: { day: "24h", week: "week", month: "month", any: "" },
      input_template: {
        jobTitles: ["{keywords}"], locations: ["{location}"], maxItems: "{limit}", postedLimit: "{date_posted}", sortBy: "date",
      },
      remote_input: { workplaceType: ["remote"] },
    }, `Monid LinkedIn fallback (docs/monid.md). Without MONID_API_KEY in .env the cascade skips it; no failure is recorded. Set a workspace spend cap in the Monid dashboard.${insertIntoCascade ? "" : " Add linkedin-monid to linkedin.cascade and set linkedin.monid.enabled: true to enable it."}`);
    for (const key of ["throttle", "date_posted"]) {
      const node = doc.getIn(["linkedin", "monid", key], true);
      if (isMap(node)) node.flow = true;
    }
  },
};

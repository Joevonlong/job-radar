import { isDeepStrictEqual } from "node:util";

import { isMap, isScalar, isSeq, type Document } from "yaml";

import type { ConfigMigration } from "../types";
import { mapAt, valueAt } from "../edit";

const APIFY = ["linkedin", "apify"] as const;
const TEMPLATE = [...APIFY, "input_template"] as const;
const DEFAULT_ACTOR = "valig/linkedin-jobs-scraper";
const OLD_TEMPLATE = { keywords: "{keywords}", location: "{location}", datePosted: "{date_posted}", limit: "{limit}" };
const OLD_DATE_POSTED = { day: "r86400", week: "r604800", month: "r2592000", any: "" };

/**
 * sources.yaml 7 -> 8: the default Apify template asks for the query's exact window (`f_TPR=r<seconds>` in `urlParam`) instead of
 * the actor's day / week / month `datePosted`. Rewrites only the old shipped template of the default actor (key order does not matter);
 * an edited template, one written for another actor, or one next to an edited `date_posted` (which the new template would not read) stays as it is.
 */
export const sources008: ConfigMigration = {
  from: 7,
  to: 8,
  description: "linkedin.apify: an unedited input_template requests the exact window (urlParam f_TPR) instead of datePosted",
  migrate(doc: Document) {
    const template = mapAt(doc, TEMPLATE);
    if (template === null || !isDeepStrictEqual(valueAt(doc, TEMPLATE), OLD_TEMPLATE)) return;
    const actor = valueAt(doc, [...APIFY, "actor_id"]);
    if (actor !== undefined && actor !== DEFAULT_ACTOR) return;
    const datePosted = valueAt(doc, [...APIFY, "date_posted"]);
    if (datePosted !== undefined && !isDeepStrictEqual(datePosted, OLD_DATE_POSTED)) return;
    const urlParam = doc.createNode([{ key: "f_TPR", value: "r{posted_within_seconds}" }]);
    if (isSeq(urlParam)) for (const entry of urlParam.items) if (isMap(entry)) entry.flow = true;
    const index = template.items.findIndex((pair) => isScalar(pair.key) && pair.key.value === "datePosted");
    template.items.splice(index, 1, doc.createPair("urlParam", urlParam));
  },
};

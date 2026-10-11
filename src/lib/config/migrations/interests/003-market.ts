/**
 * interests.yaml 2 -> 3: amounts are compared in the market's base currency, not always in EUR.
 *
 * - the amount category's `amount.min_annual_eur` -> `amount.min_annual`, `amount.rough_fx_to_eur` -> `amount.rough_fx`
 *   (values unchanged: for a German market the base currency is EUR, so they mean what they meant);
 * - saved views: `filters.hideGerman` -> `filters.hideLang` (the local language of the market).
 * Keys are renamed in place, so comments stay. A key that is already renamed is left alone (idempotent).
 */
import { isMap, isSeq, type Document } from "yaml";

import type { ConfigMigration } from "../types";
import { mapOf, renameKey } from "../yaml-nodes";

export const interests003: ConfigMigration = {
  from: 2,
  to: 3,
  description: "market packs: amount.min_annual_eur -> min_annual, amount.rough_fx_to_eur -> rough_fx (base currency); view filter hideGerman -> hideLang",
  migrate(doc: Document): void {
    const root = doc.contents;
    if (!isMap(root)) return;
    const categories: unknown = mapOf(root, "signals")?.get("categories", true);
    if (isSeq(categories)) {
      for (const category of categories.items) {
        if (!isMap(category)) continue;
        const amount = mapOf(category, "amount");
        if (!amount) continue;
        renameKey(amount, "min_annual_eur", "min_annual");
        renameKey(amount, "rough_fx_to_eur", "rough_fx");
      }
    }
    const views: unknown = root.get("views", true);
    if (isSeq(views)) {
      for (const view of views.items) {
        if (!isMap(view)) continue;
        const filters = mapOf(view, "filters");
        if (filters) renameKey(filters, "hideGerman", "hideLang");
      }
    }
  },
};

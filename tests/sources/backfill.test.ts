import { expect, it } from "vitest";

import { backfillCost, backfillPresets } from "@/lib/sources/backfill";

const card = (id: string, kind: string, enabled = true, registered = true) => ({ id, kind, enabled, registered });
// Only the fields used by the cost preview belong to its input contract.
it("filters presets by the configured cap and offers a cap below twelve hours", () => {
  expect(backfillPresets(168)).toEqual([12, 24, 48, 72, 168]);
  expect(backfillPresets(36)).toEqual([12, 24]);
  expect(backfillPresets(6)).toEqual([6]);
});
it("lists enabled registered paid channels and detects JSearch separately", () => {
  const view = { cards: [card("linkedin-apify", "paid"), card("linkedin-guest", "guest"), card("jsearch", "api"), card("off", "paid", false), card("future", "paid", true, false)] };
  expect(backfillCost(view)).toEqual({ paidChannels: ["linkedin-apify"], jsearch: true });
  expect(backfillCost(view, ["linkedin-guest"])).toEqual({ paidChannels: [], jsearch: false });
  expect(backfillCost(view, ["linkedin-apify", "linkedin-guest"])).toEqual({ paidChannels: ["linkedin-apify"], jsearch: false });
});

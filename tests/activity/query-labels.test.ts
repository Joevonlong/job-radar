import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import { resolveQueryLabels, queryLabel } from "@/lib/activity/query-labels";
import { buildQueries, buildSweepQuery } from "@/lib/channels/query";
import type { SearchConfig } from "@/lib/config";

const search: SearchConfig = { keyword_groups: { engineering: ["Platform", "AI"] }, locations: ["Example City"], remote_scope: "worldwide", window_hours: { morning: 1, evening: 2, weekend: 3 }, max_per_group_per_location: 10 };
const t = createTranslator({ locale: "en", messages: en, namespace: "activityLog" });
describe("activity query labels", () => {
  it("uses the collector's ids, current keywords, locations and translated sweep/remote labels", () => {
    const labels = resolveQueryLabels(search, t);
    const queries = buildQueries(search, "manual");
    expect(labels[queries[0]!.id]).toBe("Platform / AI · Example City");
    expect(labels[queries[1]!.id]).toBe("Platform / AI · Remote");
    expect(labels[buildSweepQuery(search, "manual").id]).toBe(t("sweep"));
    expect(queryLabel(labels, queries[0]!.id, t)).toBe(labels[queries[0]!.id]);
  });
  it("uses a short id after configuration changes, without inventing an old query label", () => {
    expect(queryLabel({}, "0123456789abcdef", t)).toBe("Query 01234567");
    expect(queryLabel({}, null, t)).toBe("Query Unknown");
  });
});

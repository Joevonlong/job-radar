import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import { liveCompanyBoards, resolveQueryLabels, queryLabel, storedCompanyQueryKeys } from "@/lib/activity/query-labels";
import { buildQueries, buildSweepQuery } from "@/lib/channels/query";
import type { SearchConfig } from "@/lib/config";

const search: SearchConfig = { keyword_groups: { engineering: ["Platform", "AI"] }, locations: ["Example City"], remote_scope: "worldwide", window_hours: { morning: 1, evening: 2, weekend: 3 }, max_per_group_per_location: 10, watched_company_queries: { enabled: true, max_per_cycle: 3, min_interval_hours: 24, max_results: 25 } };
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


it("uses current company spelling, or the stored key after removal, even when opted out", () => {
  const companies = [{ name: "Acme GmbH", key: "acme", hasBoard: true }];
  const historical = { "d5d4c4ac6877c331": "old-company" };
  const labels = resolveQueryLabels({ ...search, watched_company_queries: { ...search.watched_company_queries, enabled: false } }, t, companies, historical);
  expect(Object.values(labels)).toContain("Company: Acme GmbH");
  expect(labels["d5d4c4ac6877c331"]).toBe("Company: old-company");
  expect(storedCompanyQueryKeys({ steps: [{ name: "collect", result: { companyQueryKeys: historical } }, { name: "filter", result: null }] })).toEqual(historical);
  expect(storedCompanyQueryKeys({ steps: [{ name: "collect", result: { companyQueryKeys: { invalid: true } } }] })).toEqual({});
  expect(storedCompanyQueryKeys(null)).toEqual({});
});

it("falls back to the stored company keys when the live watch list cannot be read", () => {
  const historical = { "d5d4c4ac6877c331": "acme" };
  const failure = new Error("pipeline unreadable");
  const errors: unknown[] = [];
  const companies = liveCompanyBoards(() => { throw failure; }, (error) => errors.push(error));
  expect(companies).toEqual([]);
  expect(errors).toEqual([failure]);
  const labels = resolveQueryLabels(search, t, companies, historical);
  expect(labels["d5d4c4ac6877c331"]).toBe("Company: acme");
  expect(Object.values(labels).filter((label) => label.startsWith("Company:"))).toEqual(["Company: acme"]);
  const live = [{ name: "Acme GmbH", key: "acme", hasBoard: false }];
  expect(liveCompanyBoards(() => live)).toBe(live);
});

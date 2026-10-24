// @vitest-environment node
import { describe, expect, it } from "vitest";

import { configRegistry } from "@/lib/config";
import { MAX_FILTER_VALUES } from "@/lib/jobs/constants";
import { shippedYaml } from "../config/helpers";

const schema = configRegistry.interests.schema;

function withViews(views: unknown) {
  return schema.safeParse({ ...structuredClone(shippedYaml("interests.yaml")), views });
}

const view = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, default: false, filters: { city: "Berlin" }, ...over });
const paths = (result: ReturnType<typeof withViews>) => (result.success ? [] : result.error.issues.map((i) => (i.code === "unrecognized_keys" ? [...i.path, ...i.keys].join(".") : i.path.join("."))));

describe("interests views", () => {
  it("accepts every /jobs filter", () => {
    const filters = { q: "rust", source: "linkedin", city: "Berlin", workplace: "remote", contract: "permanent", status: "active", from: "2026-01-01", to: "2026-12-31", salary: true, filtered: true, hideLang: true, high: true };
    expect(withViews([view("all-filters", { filters })]).success).toBe(true);
  });

  it("accepts application status, minimum score and minimum salary", () => {
    expect(withViews([view("mine", { filters: { app: ["interested", "archived"], minScore: 70, minSalary: 70000 } })]).success).toBe(true);
  });

  it("rejects bad statuses, duplicates, empty lists and numbers out of range", () => {
    expect(paths(withViews([view("a", { filters: { app: ["moon"] } })]))).toEqual(["views.0.filters.app.0"]);
    expect(paths(withViews([view("a", { filters: { app: ["new", "new"] } })]))).toEqual(["views.0.filters.app"]);
    expect(paths(withViews([view("a", { filters: { app: [] } })]))).toEqual(["views.0.filters.app"]);
    expect(paths(withViews([view("a", { filters: { minScore: 101 } })]))).toEqual(["views.0.filters.minScore"]);
    expect(paths(withViews([view("a", { filters: { minScore: 70.5 } })]))).toEqual(["views.0.filters.minScore"]);
    expect(paths(withViews([view("a", { filters: { minSalary: -1 } })]))).toEqual(["views.0.filters.minSalary"]);
  });

  it("accepts companies as a list, and a view without them as before", () => {
    expect(withViews([view("one", { filters: { company: ["Zalando"] } })]).success).toBe(true);
    expect(withViews([view("two", { filters: { city: "Berlin", company: ["Zalando", "N26"] } })]).success).toBe(true);
    expect(withViews([view("none", { filters: { city: "Berlin" } })]).success).toBe(true);
  });

  it("rejects an empty, duplicated, too long or scalar company list", () => {
    expect(paths(withViews([view("a", { filters: { company: [] } })]))).toEqual(["views.0.filters.company"]);
    expect(paths(withViews([view("a", { filters: { company: ["Acme", "Acme"] } })]))).toEqual(["views.0.filters.company"]);
    expect(paths(withViews([view("a", { filters: { company: [""] } })]))).toEqual(["views.0.filters.company.0"]);
    expect(paths(withViews([view("a", { filters: { company: "Acme" } })]))).toEqual(["views.0.filters.company"]);
    const tooMany = Array.from({ length: MAX_FILTER_VALUES + 1 }, (_, i) => `C${i}`);
    expect(paths(withViews([view("a", { filters: { company: tooMany } })]))).toEqual(["views.0.filters.company"]);
  });

  it("rejects filters /jobs does not have, bad values and bad dates", () => {
    expect(paths(withViews([view("a", { filters: { signal_tier: ["T1"] } })]))).toEqual(["views.0.filters.signal_tier"]);
    expect(paths(withViews([view("a", { filters: { workplace: "moon" } })]))).toEqual(["views.0.filters.workplace"]);
    expect(paths(withViews([view("a", { filters: { from: "01.02.2026" } })]))).toEqual(["views.0.filters.from"]);
    expect(paths(withViews([view("a", { filters: { sort: "rank" } })]))).toEqual(["views.0.filters.sort"]);
  });

  it("allows at most one default view and no duplicate ids or names", () => {
    expect(paths(withViews([view("a", { default: true }), view("b", { default: true })]))).toEqual(["views.1.default"]);
    expect(paths(withViews([view("a"), view("a", { name: "other" })]))).toEqual(["views.1.id"]);
    expect(paths(withViews([view("a", { name: "Same" }), view("b", { name: "same" })]))).toEqual(["views.1.name"]);
    expect(withViews([view("a", { default: true }), view("b")]).success).toBe(true);
  });
});

describe("interests views: one value or several", () => {
  it("accepts a scalar (the shape before) and a list for each categorical filter", () => {
    expect(withViews([view("one", { filters: { city: "Berlin", workplace: "remote", source: "ats", contract: "permanent", status: "active" } })]).success).toBe(true);
    expect(withViews([view("many", { filters: { city: ["Berlin", "München"], workplace: ["remote", "hybrid"], source: ["ats", "xing"], contract: ["permanent", "freelance"], status: ["active", "closed"] } })]).success).toBe(true);
  });

  it("does not rewrite the value: scalar stays scalar, list stays list", () => {
    const result = withViews([view("one", { filters: { city: "Berlin" } }), view("many", { filters: { city: ["Berlin", "München"] } })]);
    expect(result.success && result.data.views.map((v) => v.filters.city)).toEqual(["Berlin", ["Berlin", "München"]]);
  });

  it("rejects empty lists, duplicates, too many values and unknown enum values; app stays a list", () => {
    expect(paths(withViews([view("a", { filters: { city: [] } })]))).toEqual(["views.0.filters.city"]);
    expect(paths(withViews([view("a", { filters: { city: ["Berlin", "Berlin"] } })]))).toEqual(["views.0.filters.city"]);
    expect(paths(withViews([view("a", { filters: { city: Array.from({ length: 51 }, (_, i) => `C${i}`) } })]))).toEqual(["views.0.filters.city"]);
    expect(withViews([view("a", { filters: { workplace: ["moon"] } })]).success).toBe(false);
    expect(withViews([view("a", { filters: { app: "interested" } })]).success).toBe(false);
  });
});

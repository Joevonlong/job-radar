// @vitest-environment node
import { describe, expect, it } from "vitest";

import { MAX_FILTER_VALUE_CHARS, MAX_FILTER_VALUES } from "@/lib/jobs/constants";
import { FILTER_KEYS, MULTI_FILTER_KEYS, SCALAR_COMPAT_KEYS, SELECT_FILTER_KEYS } from "@/lib/jobs/filter-keys";
import { cleanMultiValues, sortMultiValues } from "@/lib/jobs/filter-values";

describe("cleanMultiValues", () => {
  it("trims, drops empty values and dedupes (first wins) for free text, keeping the order given", () => {
    expect(cleanMultiValues("city", [" München ", "", "  ", "Berlin", "München"])).toEqual(["München", "Berlin"]);
  });

  it("drops values that are too long, and caps the list", () => {
    expect(cleanMultiValues("contract", ["x".repeat(MAX_FILTER_VALUE_CHARS + 1), "permanent"])).toEqual(["permanent"]);
    const many = Array.from({ length: MAX_FILTER_VALUES + 10 }, (_, i) => `s${i}`);
    expect(cleanMultiValues("source", many)).toHaveLength(MAX_FILTER_VALUES);
  });

  it("keeps only known values of an enum filter, in canonical order", () => {
    expect(cleanMultiValues("workplace", ["remote", "moon", "onsite", "remote"])).toEqual(["onsite", "remote"]);
    expect(cleanMultiValues("status", ["closed", "active"])).toEqual(["active", "closed"]);
    expect(cleanMultiValues("app", ["archived", "new", "nope"])).toEqual(["new", "archived"]);
    expect(cleanMultiValues("reason", ["dormant", "manual", "unknown", "gone", "manual"])).toEqual(["manual", "gone", "dormant"]);
  });

  it("sortMultiValues leaves free text alone", () => {
    expect(sortMultiValues("city", ["b", "a"])).toEqual(["b", "a"]);
  });
});

describe("filter table", () => {
  it("lists every kind of filter once, in the table order, and the kinds fit together", () => {
    expect(new Set(FILTER_KEYS).size).toBe(FILTER_KEYS.length);
    for (const key of MULTI_FILTER_KEYS) expect(FILTER_KEYS).toContain(key);
    expect([...SELECT_FILTER_KEYS, "country", "app"].sort()).toEqual([...MULTI_FILTER_KEYS].sort());
    // `company` was always a list; `reason` is URL-only and never written to a saved view.
    expect([...SCALAR_COMPAT_KEYS]).toEqual(SELECT_FILTER_KEYS.filter((key) => key !== "company" && key !== "reason"));
  });
});

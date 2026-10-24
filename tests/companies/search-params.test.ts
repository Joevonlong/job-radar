import { describe, expect, it } from "vitest";

import { COMPANY_SORTS, loadCompaniesSearchParams, serializeCompaniesParams } from "@/lib/companies/search-params";
import { MAX_FILTER_VALUE_CHARS, SORT_DIRS } from "@/lib/jobs/constants";

describe("company overview URL state", () => {
  it("uses defaults for missing and invalid values", () => {
    const defaults = { q: "", sort: "jobs", dir: "desc", page: 1 };
    expect(loadCompaniesSearchParams({})).toEqual(defaults);
    for (const page of ["0", "-1", "2.5", "2oops", "Infinity", "9007199254740992", ""]) {
      expect(loadCompaniesSearchParams({ q: "  ", sort: "rank", dir: "up", page })).toEqual(defaults);
    }
  });

  it("accepts all sorts and both directions", () => {
    for (const sort of COMPANY_SORTS) for (const dir of SORT_DIRS) {
      const params = { q: "Acme", sort, dir, page: 3 };
      expect(loadCompaniesSearchParams(new URL(serializeCompaniesParams("/companies", params), "https://example.test"))).toEqual(params);
    }
  });

  it("trims and caps search text, preserving literal punctuation", () => {
    expect(loadCompaniesSearchParams({ q: "  Acme %_  " }).q).toBe("Acme %_");
    expect(loadCompaniesSearchParams({ q: `  ${"x".repeat(MAX_FILTER_VALUE_CHARS + 1)}  ` }).q).toBe("x".repeat(MAX_FILTER_VALUE_CHARS));
    expect(serializeCompaniesParams("/companies", { q: "a,b/é" })).toBe(`/companies?${new URLSearchParams({ q: "a,b/é" })}`);
  });

  it("loads the promised search params of a server page", async () => {
    expect(await loadCompaniesSearchParams(Promise.resolve({ page: "2" }))).toMatchObject({ page: 2 });
    expect(serializeCompaniesParams("/companies", { q: "", sort: "jobs", dir: "desc", page: 1 })).toBe("/companies");
  });
});

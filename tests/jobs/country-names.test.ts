import { describe, expect, it } from "vitest";

import { withCountryNames } from "@/lib/jobs/country-names";

describe("withCountryNames", () => {
  it.each(["en", "zh"] as const)("names each country in %s and keeps codes and counts", (locale) => {
    const names = new Intl.DisplayNames([locale], { type: "region" });
    expect(withCountryNames([{ code: "DE", jobCount: 2 }, { code: "PT", jobCount: 0 }], locale)).toEqual([
      { code: "DE", jobCount: 2, name: names.of("DE") },
      { code: "PT", jobCount: 0, name: names.of("PT") },
    ]);
  });

  it("falls back to the code when the runtime has no name for it", () => {
    expect(withCountryNames([{ code: "Q1", jobCount: 1 }], "en")).toEqual([{ code: "Q1", jobCount: 1, name: "Q1" }]);
  });
});

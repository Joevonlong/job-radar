import { describe, expect, it } from "vitest";

import { insightsCities } from "@/lib/insights/load";

describe("insightsCities", () => {
  it("uses insights.yaml cities when set", () => {
    expect(insightsCities(["Berlin"], () => ["Paris"])).toEqual(["Berlin"]);
  });

  it("falls back to the preferences locations (trimmed duplicates dropped) when the list is empty", () => {
    expect(insightsCities([], () => ["Paris", "paris ", "", "Lyon"])).toEqual(["Paris", "Lyon"]);
  });
});

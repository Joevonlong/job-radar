import { describe, expect, it } from "vitest";
import { resolveBoardDensity } from "@/lib/dashboard/density";

describe("board density cookie", () => {
  it("validates the enum and uses the configured fallback for missing or invalid values", () => {
    expect(resolveBoardDensity("comfortable", "compact")).toBe("comfortable");
    expect(resolveBoardDensity("compact", "comfortable")).toBe("compact");
    for (const value of [undefined, null, "", "wide", {}, 1]) expect(resolveBoardDensity(value, "comfortable")).toBe("comfortable");
  });
});

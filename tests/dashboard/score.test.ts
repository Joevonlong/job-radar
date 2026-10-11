import { describe, expect, it } from "vitest";

import { formatRank, scoreTone } from "@/lib/dashboard/score";

describe("scoreTone", () => {
  it("uses the token bands <50, 50-69, 70-84, >=85", () => {
    expect(scoreTone(0)).toBe("low");
    expect(scoreTone(49.9)).toBe("low");
    expect(scoreTone(50)).toBe("mid");
    expect(scoreTone(69)).toBe("mid");
    expect(scoreTone(70)).toBe("good");
    expect(scoreTone(84.99)).toBe("good");
    expect(scoreTone(85)).toBe("top");
    expect(scoreTone(106)).toBe("top");
  });
});

describe("formatRank", () => {
  it("shows whole numbers without decimals and fractions with one", () => {
    expect(formatRank(84)).toBe("84");
    expect(formatRank(84.5)).toBe("84.5");
    expect(formatRank(84.25)).toBe("84.3");
  });
});

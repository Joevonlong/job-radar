// @vitest-environment node
import { describe, expect, it } from "vitest";

import { computeRankValue, finalMatchScore } from "@/lib/scoring/rank";

describe("finalMatchScore", () => {
  it("subtracts the German penalty and stays within 0..100", () => {
    expect(finalMatchScore(80, 20)).toBe(60);
    expect(finalMatchScore(80, 0)).toBe(80);
    expect(finalMatchScore(15, 25)).toBe(0);
    expect(finalMatchScore(100, 0)).toBe(100);
    expect(finalMatchScore(72.4, 0)).toBe(72);
  });
});

describe("computeRankValue", () => {
  it("is the match score without signals", () => {
    expect(computeRankValue(70, 0, 15)).toBe(70);
  });

  it("adds the signal bonus up to the cap", () => {
    expect(computeRankValue(70, 8, 15)).toBe(78);
    expect(computeRankValue(70, 15, 15)).toBe(85);
    expect(computeRankValue(70, 22, 15)).toBe(85);
  });

  it("follows the configured cap, may exceed 100, and never lets a bad bonus lower the score", () => {
    expect(computeRankValue(95, 22, 10)).toBe(105);
    expect(computeRankValue(70, -5, 15)).toBe(70);
    expect(computeRankValue(70, 5, -3)).toBe(70);
  });

  it("keeps two decimals", () => {
    expect(computeRankValue(70, 2.456, 15)).toBe(72.46);
  });
});

import { describe, expect, it } from "vitest";

import { capBar } from "@/lib/dashboard/cap-bar";
import { floorCheck } from "@/lib/dashboard/floor-check";
import { germanCheck } from "@/lib/dashboard/german-check";
import { quotesFoundInJd } from "@/lib/dashboard/jd";
import { scoreMetaText } from "@/lib/dashboard/score-meta";
import { annualBaseFigure } from "@/lib/domain/salary";
import type { JobSalary } from "@/lib/domain/types";
import { jobViewTransitionName } from "@/components/jobs/view-transition";
import { jdMarkId } from "@/components/jobs/detail/marks";
import { asSalary } from "../helpers/salary";

const salary = (over: Partial<JobSalary> = {}): JobSalary => asSalary({
  raw: "x",
  currency: "EUR",
  period: "year",
  min: 85000,
  max: 105000,
  perYear: { min: 85000, max: 105000 },
  eurPerYear: { min: 85000, max: 105000 },
  periodAssumed: false,
  origin: "description",
  qualityStatus: "valid",
  reasonCodes: [],
  ...over,
});

/** A category as the bar stacks it. */
const entry = (id: string, points: number) => ({ id, points, color: "amber" as const, code: id, label: id });

describe("capBar", () => {
  it("stacks the tiers, hatches what goes over the cap and counts min(total, cap)", () => {
    const bar = capBar(
      [
        entry("T1", 10),
        entry("T2", 8),
        entry("T4", 2),
      ],
      15,
    );
    expect(bar.total).toBe(20);
    expect(bar.counted).toBe(15);
    expect(bar.capped).toBe(true);
    expect(bar.capAt).toBe(75);
    expect(bar.pieces.map((p) => [p.id, p.counted, p.over])).toEqual([
      ["T1", 10, 0],
      ["T2", 5, 3],
      ["T4", 0, 2],
    ]);
    expect(bar.pieces.map((p) => p.width)).toEqual([50, 40, 10]);
    expect(bar.pieces[2]?.overShare).toBe(100);
    // the counted parts add up to the signal bonus of the rank value
    expect(bar.pieces.reduce((sum, p) => sum + p.counted, 0)).toBe(bar.counted);
  });

  it("leaves room under the cap when the total is smaller", () => {
    const bar = capBar([entry("T2", 8)], 15);
    expect(bar.capped).toBe(false);
    expect(bar.counted).toBe(8);
    expect(bar.capAt).toBe(100);
    expect(bar.pieces[0]?.width).toBeCloseTo((8 / 15) * 100);
  });

  it("is empty without tiers", () => {
    expect(capBar([], 15)).toMatchObject({ pieces: [], total: 0, counted: 0, capped: false });
  });
});

describe("germanCheck (C3: no guess when the posting is silent)", () => {
  it("shows only your level for none / preferred / unknown", () => {
    expect(germanCheck("none", "B1")).toMatchObject({ state: "not_required", mine: "B1", required: null });
    expect(germanCheck("preferred", "B1")).toMatchObject({ state: "preferred", required: null });
    expect(germanCheck("unknown", null)).toMatchObject({ state: "unknown", mine: null, required: null });
  });
  it("compares a required level with yours", () => {
    expect(germanCheck("B1", "B2")).toMatchObject({ state: "met", mine: "B2", required: "B1", gap: 0 });
    expect(germanCheck("C1", "B1")).toMatchObject({ state: "gap", gap: 2, required: "C1" });
    expect(germanCheck("B2", null)).toMatchObject({ state: "no_german", mine: null, required: "B2" });
  });
  it("puts native on C2", () => {
    expect(germanCheck("C2", "native")).toMatchObject({ state: "met", mine: "C2", native: true });
  });
});

describe("floorCheck", () => {
  it("compares the upper end with the floor", () => {
    expect(floorCheck(salary(), 70000, "EUR")).toEqual({ state: "pass", top: 105000, floor: 70000, approx: false, currency: "EUR" });
    expect(floorCheck(salary({ eurPerYear: { min: null, max: 58000 } }), 70000, "EUR")).toMatchObject({ state: "fail", top: 58000 });
    expect(floorCheck(salary({ eurPerYear: { min: 80000, max: null } }), 70000, "EUR")).toMatchObject({ state: "pass", top: 80000 });
  });
  it("does not judge what it cannot read", () => {
    expect(floorCheck(null, 70000, "EUR").state).toBe("no_salary");
    expect(floorCheck(salary({ eurPerYear: null }), 70000, "EUR").state).toBe("no_salary");
    expect(floorCheck(salary({ qualityStatus: "review" }), 70000, "EUR").state).toBe("no_salary");
    expect(floorCheck(salary({ otherRegion: "currency" }), 70000, "EUR").state).toBe("other_region");
    expect(floorCheck(salary(), null, "EUR").state).toBe("no_floor");
  });
});

describe("annualEurFigure", () => {
  it("is the middle of a range or the one stated bound", () => {
    expect(annualBaseFigure(salary(), "EUR")).toBe(95000);
    expect(annualBaseFigure(salary({ eurPerYear: { min: null, max: 120000 } }), "EUR")).toBe(120000);
    expect(annualBaseFigure(salary({ eurPerYear: { min: 90000, max: null } }), "EUR")).toBe(90000);
  });
  it("is null for no, unreviewed, other-region or unconverted salaries", () => {
    expect(annualBaseFigure(null, "EUR")).toBeNull();
    expect(annualBaseFigure(salary({ eurPerYear: null }), "EUR")).toBeNull();
    expect(annualBaseFigure(salary({ qualityStatus: "review" }), "EUR")).toBeNull();
    expect(annualBaseFigure(salary({ otherRegion: "description" }), "EUR")).toBeNull();
  });
});

describe("quotesFoundInJd (the jump target exists)", () => {
  const jd = "Intro line.\n\nWhat we offer:\n- Salary: EUR 90,000 per year.\n- Stock options (ESOP) for all.\n\nFirst paragraph ends here.\n\nSecond one starts.";
  it("finds a quote in a paragraph or a list item, not one that is missing or spans two blocks", () => {
    expect(quotesFoundInJd(jd, ["Salary: EUR 90,000 per year.", "Stock options (ESOP) for all.", "Never written in the JD", "ends here. Second one starts."])).toEqual([true, true, false, false]);
  });
  it("finds nothing without a JD", () => {
    expect(quotesFoundInJd(null, ["x"])).toEqual([false]);
  });
  it("gives the second of two identical quotes no target", () => {
    expect(quotesFoundInJd("Same sentence here.", ["Same sentence here.", "Same sentence here."])).toEqual([true, false]);
  });
});

describe("names", () => {
  it("derives the shared element names from the job id", () => {
    expect(jobViewTransitionName(42, "title")).toBe("job-42-title");
    expect(jobViewTransitionName(42, "score")).toBe("job-42-score");
    expect(jobViewTransitionName(7, "title")).not.toBe(jobViewTransitionName(42, "title"));
    expect(jobViewTransitionName("a/b c", "score")).toBe("job-abc-score");
    expect(jdMarkId(3)).toBe("jd-quote-3");
  });
});

describe("scoreMetaText (C3: no placeholders for what is not known)", () => {
  const labels = { by: (p: string) => `by ${p}`, model: (m: string) => m, prompt: (v: string) => `prompt ${v}` };
  it("joins what is known", () => {
    expect(scoreMetaText({ provider: "codex-cli", model: "gpt-5", promptVersion: "v3", when: "10/8 05:42" }, labels)).toBe("by codex-cli · gpt-5 · prompt v3 · 10/8 05:42");
  });
  it("leaves out unknown parts and a model that repeats the provider", () => {
    expect(scoreMetaText({ provider: "seed", model: "seed", promptVersion: null, when: null }, labels)).toBe("by seed");
    expect(scoreMetaText({ provider: "x", model: null, promptVersion: " ", when: "now" }, labels)).toBe("by x · now");
  });
  it("is null when nothing is known", () => {
    expect(scoreMetaText({ provider: null, model: null, promptVersion: null, when: null }, labels)).toBeNull();
  });
});

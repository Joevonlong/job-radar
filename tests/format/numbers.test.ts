import { describe, expect, it } from "vitest";

import {
  formatCount,
  formatDelta,
  formatFraction,
  formatInteger,
  formatPercent,
  formatPercentagePoints,
  formatPercentChange,
  formatSalary,
  formatScore,
  formatScoreValue,
  MINUS,
  percentParts,
  ratioPercent,
  UNKNOWN,
} from "@/lib/format/numbers";

/** Every example of docs/design/tokens.md "数字格式" (the "写成" column), plus the edge cases around it. */
describe("formatInteger", () => {
  it.each([
    [1284, "1,284"],
    [0, "0"],
    [12, "12"],
    [1_000_000, "1,000,000"],
    [1283.6, "1,284"],
    [-1284, "-1,284"],
  ])("%s -> %s", (value, expected) => {
    expect(formatInteger(value, "zh")).toBe(expected);
    expect(formatInteger(value, "en")).toBe(expected);
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])("unknown %s -> —, never 0", (value) => {
    expect(formatInteger(value, "zh")).toBe(UNKNOWN);
  });
});

describe("formatCount", () => {
  it("puts one space between number and unit (Chinese measure words)", () => {
    expect(formatCount(6, "条", "zh")).toBe("6 条");
    expect(formatCount(12, "个岗位", "zh")).toBe("12 个岗位");
    expect(formatCount(1284, "jobs", "en")).toBe("1,284 jobs");
  });
  it("is — for an unknown count", () => {
    expect(formatCount(null, "条", "zh")).toBe(UNKNOWN);
  });
});

describe("formatPercent", () => {
  it.each([
    [41.37, "41%"],
    [41.5, "42%"],
    [10, "10%"],
    [10.4, "10%"],
    [9.96, "10%"], // rounds up into two digits: whole
    [2.64, "2.6%"],
    [3, "3.0%"], // < 10 always keeps one decimal
    [9.94, "9.9%"],
    [0.1, "0.1%"],
    [0.14, "0.1%"],
    [0.04, "<0.1%"],
    [0.0001, "<0.1%"],
    [0, "0%"],
    [100, "100%"],
    [99.6, "100%"],
    [-3.2, `${MINUS}3.2%`],
    [-0.04, `${MINUS}<0.1%`],
  ])("%s -> %s", (value, expected) => {
    expect(formatPercent(value)).toBe(expected);
  });

  it("does not use the forbidden spellings of the table", () => {
    expect(formatPercent(41.37)).not.toBe("41.37%");
    expect(formatPercent(3)).not.toBe("3%");
  });

  it("is — for unknown", () => {
    expect(formatPercent(null)).toBe(UNKNOWN);
    expect(formatPercent(undefined)).toBe(UNKNOWN);
    expect(formatPercent(Number.NaN)).toBe(UNKNOWN);
  });

  it("percentParts keeps the number and the unit apart", () => {
    expect(percentParts(24)).toEqual({ text: "24", unit: "%" });
    expect(percentParts(0.01)).toEqual({ text: "<0.1", unit: "%" });
    expect(percentParts(null)).toEqual({ text: UNKNOWN, unit: "" });
  });
});

describe("formatPercentChange / formatPercentagePoints", () => {
  it("quantity changes use %", () => {
    expect(formatPercentChange(18)).toBe("+18%");
    expect(formatPercentChange(-3.2)).toBe(`${MINUS}3.2%`);
    expect(formatPercentChange(0)).toBe("0%");
    expect(formatPercentChange(null)).toBe(UNKNOWN);
  });

  it("ratio changes use pt, not %", () => {
    expect(formatPercentagePoints(2)).toBe("+2pt");
    expect(formatPercentagePoints(-1.5)).toBe(`${MINUS}1.5pt`);
    expect(formatPercentagePoints(12.4)).toBe("+12pt");
    expect(formatPercentagePoints(0)).toBe("0pt");
    expect(formatPercentagePoints(0.02)).toBe("+<0.1pt");
    expect(formatPercentagePoints(undefined)).toBe(UNKNOWN);
    expect(formatPercentagePoints(2)).not.toBe("+2%");
  });
});

describe("formatScore", () => {
  it.each([
    [88, "88/100"],
    [87.6, "88/100"],
    [0, "0/100"],
    [100, "100/100"],
    [120, "100/100"], // out of range stays inside the scale
    [-5, "0/100"],
  ])("%s -> %s", (value, expected) => {
    expect(formatScore(value)).toBe(expected);
  });

  it("an unscored job is —, never 0 or '88 分'", () => {
    expect(formatScore(null)).toBe(UNKNOWN);
    expect(formatScoreValue(undefined)).toBe(UNKNOWN);
    expect(formatScore(88)).not.toContain("分");
  });

  it("takes another scale", () => {
    expect(formatScore(7.4, 10)).toBe("7/10");
  });
});

describe("formatFraction", () => {
  it.each([
    [62, 135, "62/135 · 46%"],
    [184, 200, "184/200 · 92%"],
    [1284, 2000, "1,284/2,000 · 64%"],
    [0, 135, "0/135 · 0%"],
    [135, 135, "135/135 · 100%"],
    [1, 3000, "1/3,000 · <0.1%"],
  ])("%s of %s -> %s", (part, whole, expected) => {
    expect(formatFraction(part, whole, "zh")).toBe(expected);
  });

  it("has no percentage for an empty whole, and is — for unknown parts", () => {
    expect(formatFraction(0, 0, "zh")).toBe("0/0");
    expect(formatFraction(null, 135, "zh")).toBe(UNKNOWN);
    expect(formatFraction(62, undefined, "zh")).toBe(UNKNOWN);
    expect(formatFraction(62, 135, "zh")).not.toContain("of");
  });

  it("ratioPercent", () => {
    expect(ratioPercent(62, 135)).toBeCloseTo(45.93, 1);
    expect(ratioPercent(1, 0)).toBeNull();
    expect(ratioPercent(null, 5)).toBeNull();
  });
});

describe("formatDelta", () => {
  it.each([
    [12, "", "▲ +12", "up"],
    [-3, "", `▼ ${MINUS}3`, "down"],
    [0, "", "■ 0", "flat"],
    [2, "pt", "▲ +2pt", "up"],
    [-1.5, "pt", `▼ ${MINUS}1.5pt`, "down"],
    [-10.5, "pt", `▼ ${MINUS}11pt`, "down"], // from 10 on whole numbers, like percentages
    [9.96, "pt", "▲ +10pt", "up"],
    [-9.4, "pt", `▼ ${MINUS}9.4pt`, "down"],
    [12.4, "%", "▲ +12%", "up"],
    [18, "%", "▲ +18%", "up"],
    [1200, "", "▲ +1,200", "up"],
    [0.04, "", "■ 0", "flat"], // rounds to nothing: flat, not a fake up arrow
  ] as const)("%s%s -> %s", (value, unit, expected, direction) => {
    const delta = formatDelta(value, unit, "zh");
    expect(delta?.full).toBe(expected);
    expect(delta?.direction).toBe(direction);
  });

  it("uses the real minus sign, never '+-3' or a hyphen", () => {
    const delta = formatDelta(-3, "", "zh");
    expect(delta?.text).toBe(`${MINUS}3`);
    expect(delta?.text).not.toContain("-");
    expect(delta?.full).not.toBe("+-3");
  });

  it("is null for unknown", () => {
    expect(formatDelta(null, "", "zh")).toBeNull();
    expect(formatDelta(Number.NaN, "", "zh")).toBeNull();
  });
});

describe("formatSalary", () => {
  it("range in thousands with an en dash", () => {
    expect(formatSalary({ min: 95_000, max: 120_000, currency: "EUR" }, { locale: "zh" })).toBe("€95–120k");
    expect(formatSalary({ min: 95_000, max: 120_000, currency: "EUR" }, { locale: "zh" })).not.toBe("95000-120000 EUR");
  });

  it("adds the period only when asked", () => {
    expect(formatSalary({ min: 95_000, max: 120_000, currency: "EUR" }, { period: "year", locale: "zh" })).toBe("€95–120k /年");
    expect(formatSalary({ min: 95_000, max: 120_000, currency: "EUR" }, { period: "year", locale: "en" })).toBe("€95–120k /yr");
    expect(formatSalary({ min: 5_000, max: 6_000, currency: "EUR" }, { period: "month", locale: "zh" })).toBe("€5–6k /月");
  });

  it("single bound says which one", () => {
    expect(formatSalary({ max: 120_000, currency: "EUR" }, { locale: "zh" })).toBe("最高 €120k");
    expect(formatSalary({ min: 90_000, currency: "EUR" }, { locale: "zh" })).toBe("€90k 起");
    expect(formatSalary({ max: 120_000, currency: "EUR" }, { locale: "en" })).toBe("up to €120k");
    expect(formatSalary({ min: 90_000, currency: "EUR" }, { locale: "en" })).toBe("€90k and up");
  });

  it("converted figures get ≈", () => {
    expect(formatSalary({ min: 129_000, max: 156_000, approx: true, currency: "EUR" }, { locale: "zh" })).toBe("≈ €129–156k");
    expect(formatSalary({ min: 129_000, max: 156_000, approx: true, currency: "EUR" }, { locale: "zh" })).not.toBe("€129–156k");
  });

  it("keeps one decimal when needed, collapses an equal range, writes other currencies", () => {
    expect(formatSalary({ min: 92_500, max: 100_000, currency: "EUR" }, { locale: "zh" })).toBe("€92.5–100k");
    expect(formatSalary({ min: 80_000, max: 80_000, currency: "EUR" }, { locale: "zh" })).toBe("€80k");
    expect(formatSalary({ min: 140_000, max: 170_000, currency: "USD" }, { locale: "zh" })).toBe("$140–170k");
    expect(formatSalary({ min: 100_000, max: 120_000, currency: "CHF" }, { locale: "zh" })).toBe("CHF 100–120k");
    // No currency given (the market cannot be resolved): the figure alone
    expect(formatSalary({ min: 95_000, max: 120_000 }, { locale: "zh" })).toBe("95–120k");
  });

  it("small amounts (hourly) are not abbreviated", () => {
    expect(formatSalary({ min: 45, max: 60, currency: "EUR" }, { locale: "zh" })).toBe("€45–60");
  });

  it("swaps a reversed range", () => {
    expect(formatSalary({ min: 120_000, max: 95_000, currency: "EUR" }, { locale: "zh" })).toBe("€95–120k");
  });

  it("writes whole k, except a range narrower than 10k (and a single bound)", () => {
    expect(formatSalary({ min: 139_320, max: 163_400, approx: true, currency: "EUR" }, { locale: "zh" })).toBe("≈ €139–163k");
    expect(formatSalary({ min: 139_320, max: 163_400, approx: true, currency: "EUR" }, { locale: "en", period: "year" })).toBe("≈ €139–163k /yr");
    expect(formatSalary({ min: 92_500, max: 100_000, currency: "EUR" }, { locale: "zh" })).toBe("€92.5–100k");
    expect(formatSalary({ min: 100_000, max: 109_900, currency: "EUR" }, { locale: "zh" })).toBe("€100–109.9k");
    expect(formatSalary({ min: 100_000, max: 110_000, currency: "EUR" }, { locale: "zh" })).toBe("€100–110k");
    expect(formatSalary({ min: 86_400, max: 86_400, currency: "EUR" }, { locale: "zh" })).toBe("€86.4k");
    expect(formatSalary({ max: 139_320, approx: true, currency: "EUR" }, { locale: "zh" })).toBe("≈ 最高 €139k");
    // a converted figure (a monthly salary times 12) is an estimate: whole k, behind ≈
    expect(formatSalary({ min: 86_400, max: 86_400, approx: true, currency: "EUR" }, { period: "year", locale: "zh" })).toBe("≈ €86k /年");
    expect(formatSalary({ min: 92_500, max: 100_000, approx: true, currency: "EUR" }, { locale: "zh" })).toBe("≈ €93–100k");
  });

  it("writes every period the posting can state", () => {
    expect(formatSalary({ min: 1_200, max: 1_500, currency: "EUR" }, { period: "week", locale: "en" })).toBe("€1.2–1.5k /wk");
    expect(formatSalary({ min: 7_200, max: 7_200, currency: "EUR" }, { period: "month", locale: "zh" })).toBe("€7.2k /月");
  });

  it("undisclosed is null, not €0", () => {
    expect(formatSalary({}, { locale: "zh" })).toBeNull();
    expect(formatSalary({ min: null, max: undefined, currency: "EUR" }, { locale: "zh" })).toBeNull();
    expect(formatSalary({ min: Number.NaN, currency: "EUR" }, { locale: "zh" })).toBeNull();
  });
});

describe("formatUsdAmount", () => {
  it("writes a plain $ in both locales and keeps four decimals under a dollar", async () => {
    const { formatUsdAmount } = await import("@/lib/format/numbers");
    for (const locale of ["zh-CN", "en-US"]) {
      const format = { number: (value: number, options: { minimumFractionDigits: number; maximumFractionDigits: number }) => new Intl.NumberFormat(locale, options).format(value) };
      expect(formatUsdAmount(format, 0)).toBe("$0.00");
      expect(formatUsdAmount(format, 0.0123)).toBe("$0.0123");
      expect(formatUsdAmount(format, 1234.5)).toBe("$1,234.50");
    }
  });
});

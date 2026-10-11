// @vitest-environment node
import { describe, expect, it } from "vitest";

import { normalizeSalary, parseNumberToken, parseSalaryText } from "@/lib/pipeline/salary";

import { draft, pipelineWith, shippedPipeline } from "./helpers";

const config = shippedPipeline();
const parse = (text: string) => parseSalaryText(text, config, { requireCurrency: false });
const salary = (salaryText: string) => normalizeSalary(draft({ salaryText }), config);

describe("number formats", () => {
  it.each([
    ["85.000", false, 85000],
    ["85,000", false, 85000],
    ["85.000,00", false, 85000],
    ["85,000.50", false, 85000.5],
    ["1.250.000", false, 1250000],
    ["85 000", false, 85000],
    ["45,5", false, 45.5],
    ["45.50", false, 45.5],
    ["85.5", true, 85.5],
    ["85000", false, 85000],
  ])("%s -> %d", (token, hasK, expected) => {
    expect(parseNumberToken(token, hasK)).toBe(expected);
  });
});

describe("salary text parsing", () => {
  it("reads a German annual amount: 85.000 €", () => {
    expect(parse("85.000 €")).toEqual({ min: 85000, max: 85000, currency: "EUR", period: "year", periodAssumed: true });
  });

  it("reads 85.000,00 EUR", () => {
    expect(parse("85.000,00 EUR")).toMatchObject({ min: 85000, max: 85000, currency: "EUR" });
  });

  it.each([
    ["EUR 85,000 - 105,000", 85000, 105000],
    ["85.000 – 105.000 €", 85000, 105000],
    ["85.000 € - 105.000 €", 85000, 105000],
    ["€85,000 to €105,000", 85000, 105000],
    ["70.000 bis 90.000 € pro Jahr", 70000, 90000],
    ["zwischen 70.000 und 90.000 €", 70000, 90000],
    ["85k - 105k EUR", 85000, 105000],
    ["85-105k €", 85000, 105000],
    ["85.5k€", 85500, 85500],
  ])("range %s", (text, min, max) => {
    expect(parse(text)).toMatchObject({ min, max, currency: "EUR" });
  });

  it.each([
    ["€75,000/yr - €100,000/yr", 75000, 100000, "EUR", "year"],
    ["€75,000.00/yr - €100,000.00/yr", 75000, 100000, "EUR", "year"],
    ["€75K/yr - €100K/yr", 75000, 100000, "EUR", "year"],
    ["$120,000.00 - $150,000.00", 120000, 150000, "USD", "year"],
    ["75.000 € - 100.000 €", 75000, 100000, "EUR", "year"],
    ["EUR 75k–100k p.a.", 75000, 100000, "EUR", "year"],
    ["75.000 € p.a. bis 100.000 € p.a.", 75000, 100000, "EUR", "year"],
    ["€6,000 per month - €8,000 per month", 6000, 8000, "EUR", "month"],
    ["70.000 € brutto - 90.000 € brutto pro Jahr", 70000, 90000, "EUR", "year"],
    ["€60.000 EUR - €80.000 EUR", 60000, 80000, "EUR", "year"],
  ])("a unit on both ends of a range: %s", (text, min, max, currency, period) => {
    expect(parse(text)).toMatchObject({ min, max, currency, period });
  });

  it("reads two amounts of one currency side by side as a range", () => {
    expect(parse("$184,050 $262,928")).toMatchObject({ min: 184050, max: 262928, currency: "USD" });
    expect(parse("500 € 600 €")).toMatchObject({ min: 500, max: 500 }); // no symbol in front: not a range
  });

  it("does not join two unrelated amounts into a range", () => {
    expect(parse("€75,000/yr and a budget of 2.000 € for learning")).toMatchObject({ min: 75000, max: 75000 });
    expect(parse("€75,000/yr plus equity, relocation up to €100,000")).toMatchObject({ min: 75000, max: 75000 });
  });

  it("keeps up-to as a maximum only and from as a minimum only", () => {
    expect(parse("up to €120k per year")).toMatchObject({ min: null, max: 120000, currency: "EUR", period: "year", periodAssumed: false });
    expect(parse("bis zu 120.000 € brutto/Jahr")).toMatchObject({ min: null, max: 120000, period: "year" });
    expect(parse("ab 90.000 €")).toMatchObject({ min: 90000, max: null });
    expect(parse("from EUR 90k")).toMatchObject({ min: 90000, max: null });
  });

  it("does not take a trailing 'ab' inside a word for a lower bound", () => {
    expect(parse("Lab 90.000 €")).toMatchObject({ min: 90000, max: 90000 });
  });

  it.each([
    ["4.500 € monatlich", "month"],
    ["4.500 € pro Monat", "month"],
    ["EUR 5,000 per month", "month"],
    ["45 €/Stunde", "hour"],
    ["€45 per hour", "hour"],
    ["600 € Tagessatz", "day"],
    ["900 € pro Woche", "week"],
    ["85.000 € p.a.", "year"],
    ["Jahresgehalt 85.000 €", "year"],
    ["85.000 € brutto pro Jahr bei 40 Stunden/Woche", "year"],
  ])("period of %s", (text, period) => {
    expect(parse(text)?.period).toBe(period);
  });

  it("never invents a currency or a period", () => {
    expect(parse("up to 120k")).toMatchObject({ currency: null, period: "year", periodAssumed: true });
    expect(parse("800")).toMatchObject({ currency: null, period: null, periodAssumed: false });
    expect(parse("competitive")).toBeNull();
  });

  it("requires money evidence for free text", () => {
    const strict = (text: string) => parseSalaryText(text, config, { requireCurrency: true });
    expect(strict("We are 25 people in 3 offices")).toBeNull();
    expect(strict("Salary 85,000 - 105,000 (EUR)")).toMatchObject({ min: 85000, max: 105000, currency: "EUR" });
  });
});

describe("salary conversion", () => {
  it("converts month, week, day and hour to EUR per year with the documented factors", () => {
    expect(salary("4.500 € pro Monat")).toMatchObject({ perYear: { min: 54000, max: 54000 }, eurPerYear: { min: 54000, max: 54000 } });
    expect(salary("900 € pro Woche")?.eurPerYear).toEqual({ min: 46800, max: 46800 });
    expect(salary("600 € Tagessatz")?.eurPerYear).toEqual({ min: 156000, max: 156000 });
    expect(salary("45,50 €/Stunde")?.eurPerYear).toEqual({ min: 94640, max: 94640 });
  });

  it("keeps the stated figures and the raw text", () => {
    expect(salary("4.500 - 5.500 € pro Monat")).toMatchObject({
      raw: "4.500 - 5.500 € pro Monat",
      min: 4500,
      max: 5500,
      period: "month",
      currency: "EUR",
      origin: "text",
      qualityStatus: "valid",
      eurPerYear: { min: 54000, max: 66000 },
    });
  });

  it("uses the factors from the config", () => {
    const custom = pipelineWith((raw) => {
      (raw.salary as { periods_per_year: Record<string, number> }).periods_per_year.hour = 1800;
    });
    expect(normalizeSalary(draft({ salaryText: "50 €/Stunde" }), custom)?.eurPerYear).toEqual({ min: 90000, max: 90000 });
  });

  it("does not convert foreign currencies unless the config has a rate", () => {
    const noRates = pipelineWith((raw) => {
      (raw.salary as { fx_rates: Record<string, number> }).fx_rates = {};
    });
    expect(normalizeSalary(draft({ salaryText: "£60k per year" }), noRates)).toMatchObject({ currency: "GBP", perYear: { min: 60000, max: 60000 }, eurPerYear: null, qualityStatus: "valid" });
    const withRate = pipelineWith((raw) => {
      (raw.salary as { fx_rates: Record<string, number> }).fx_rates = { GBP: 1.15 };
    });
    expect(normalizeSalary(draft({ salaryText: "£60k per year" }), withRate)?.eurPerYear).toEqual({ min: 69000, max: 69000 });
  });

  it("flags what it cannot trust instead of guessing", () => {
    expect(salary("competitive")).toMatchObject({ raw: "competitive", min: null, max: null, qualityStatus: "review", reasonCodes: ["SALARY_UNPARSED"] });
    expect(salary("85k")).toMatchObject({ currency: null, qualityStatus: "review", reasonCodes: expect.arrayContaining(["SALARY_CURRENCY_UNKNOWN"]) });
    expect(salary("800 €")).toMatchObject({ period: null, eurPerYear: null, qualityStatus: "review", reasonCodes: expect.arrayContaining(["SALARY_PERIOD_UNKNOWN"]) });
    expect(salary("105.000 - 85.000 € p.a.")?.reasonCodes).toContain("SALARY_MIN_EXCEEDS_MAX");
    expect(salary("500 € p.a.")?.reasonCodes).toContain("ANNUAL_AMOUNT_IMPLAUSIBLY_LOW");
    expect(salary("5.000.000 € p.a.")?.reasonCodes).toContain("ANNUAL_AMOUNT_IMPLAUSIBLY_HIGH");
  });

  it("notes an assumed annual period without distrusting the figures", () => {
    expect(salary("85.000 €")).toMatchObject({ periodAssumed: true, qualityStatus: "valid", reasonCodes: ["PERIOD_ASSUMED_YEAR"] });
  });
});

describe("salary sources", () => {
  it("prefers the channel's structured salary", () => {
    const result = normalizeSalary(
      draft({
        salary: { min: 5000, max: 6000, currency: "EUR", period: "month", raw: "5-6k/month" },
        salaryText: "ignored 1 €",
      }),
      config,
    );
    expect(result).toMatchObject({ origin: "channel", raw: "5-6k/month", eurPerYear: { min: 60000, max: 72000 } });
  });

  it("falls back to a description sentence that names a salary", () => {
    const result = normalizeSalary(
      draft({ description: "Join us in Berlin. Salary range EUR 85,000 - 105,000 plus equity. 3 days in the office." }),
      config,
    );
    expect(result).toMatchObject({ origin: "description", min: 85000, max: 105000, currency: "EUR" });
  });

  it("reads the whole range from a description that gives a unit on both ends", () => {
    const result = normalizeSalary(draft({ description: "Salary range (annual brutto): €60.000 EUR - €80.000 EUR Show more Show less" }), config);
    expect(result).toMatchObject({ origin: "description", min: 60000, max: 80000, currency: "EUR", qualityStatus: "valid", raw: "Salary range (annual brutto): €60.000 EUR - €80.000 EUR" });
    const redis = normalizeSalary(draft({ description: "Compensation: The salary range for this role is EUR 105 000 to 131 000." }), config);
    expect(redis).toMatchObject({ min: 105000, max: 131000, currency: "EUR", period: "year" });
  });

  it("reads a currency range without thousands separators and no salary word", () => {
    const google = normalizeSalary(draft({ description: "Individual pay is determined by skills.\n\nGermany: €148000 - €151000 (EUR) + 20% bonus target + equity + benefits\n\nRes" }), config);
    expect(google).toMatchObject({ origin: "description", min: 148000, max: 151000, currency: "EUR", period: "year" });
    expect(normalizeSalary(draft({ description: "Relocation support: €20000 - €25000 for your move." }), config)).toBeNull();
    // years, postcodes, ids and plain counts have no currency sign
    expect(normalizeSalary(draft({ description: "Founded 2012 - 2024 in 80331 Munich, job id 148000 - 151000, 2000 - 3000 employees." }), config)).toBeNull();
  });

  it("marks a salary that is OTE / on-target earnings", () => {
    expect(normalizeSalary(draft({ salaryText: "OTE: 160,000 - 200,000 USD per year" }), config)).toMatchObject({ includesVariable: true });
    expect(normalizeSalary(draft({ description: "On-target earnings: EUR 90,000 - 110,000 per year plus equity." }), config)).toMatchObject({ includesVariable: true });
    expect(normalizeSalary(draft({ salaryText: "EUR 90,000 - 110,000 per year" }), config)?.includesVariable).toBeUndefined();
  });

  it("never reads a benefit number as a salary (relocation, allowance, learning budget ...)", () => {
    const helmwerk =
      "What We Offer Competitive salary and VSOP options Relocation support: up to €2,500 and 4 weeks temporary accommodation Learning: €500/£450 yearly allowance Health & wellness: gym membership and mental health support (Nilo.health) Social: regular company events and monthly social allowances Enhanced parental leave: 22 weeks fully paid";
    expect(normalizeSalary(draft({ description: helmwerk }), config)).toBeNull();
    const dash0 =
      "What we offer: Competitive salary & meaningful equity participation — you'll own part of what you're building Flexible, remote-first work environment with offices in New York, Amsterdam, and Munich €60/month phone & internet allowance Location-specific benefits";
    expect(normalizeSalary(draft({ description: dash0 }), config)).toBeNull();
    expect(normalizeSalary(draft({ description: "Salary: competitive. Learning budget of €2,000 per year for conferences." }), config)).toBeNull();
    expect(normalizeSalary(draft({ description: "Unser Gehalt ist fair. Wir zahlen einen Umzugszuschuss von 5.000 €." }), config)).toBeNull();
  });

  it("keeps the salary when a benefit is mentioned further from the amount than the salary word", () => {
    expect(normalizeSalary(draft({ description: "Salary: €80,000 - €100,000 per year plus relocation support." }), config)).toMatchObject({ min: 80000, max: 100000 });
    expect(normalizeSalary(draft({ description: "Gehalt: 85.000 € brutto/Jahr, 30 Tage Urlaub" }), config)).toMatchObject({ min: 85000, max: 85000 });
  });

  it("takes the salary and skips the benefit when both are in one paragraph", () => {
    const text = "Learning budget of €2,000 per year. Base salary: €90,000 - €110,000 per year.";
    expect(normalizeSalary(draft({ description: text }), config)).toMatchObject({ min: 90000, max: 110000, raw: "salary: €90,000 - €110,000 per year" });
  });

  it("reads a range whose period is named even without a salary word, but not a bare amount", () => {
    expect(normalizeSalary(draft({ description: "Staff Engineer. €80,000 - €120,000 gross a year. Remote friendly." }), config)).toMatchObject({ min: 80000, max: 120000, period: "year", periodAssumed: false });
    expect(normalizeSalary(draft({ description: "Our office has 120.000 € of new furniture." }), config)).toBeNull();
    expect(normalizeSalary(draft({ description: "Learning budget €1,000 - €2,000 per year." }), config)).toBeNull();
  });

  it("finds the base range of a pay-transparency paragraph a few lines below its heading", () => {
    const text = "The base salary range below is for the role in California, based on a Full Time Schedule.\n$150,000 — $175,000 USD\n\nWhat we offer";
    expect(normalizeSalary(draft({ description: text }), config)).toMatchObject({ min: 150000, max: 175000, currency: "USD", raw: "$150,000 — $175,000 USD" });
    expect(normalizeSalary(draft({ description: "The United States base range for this position is $184,050 - $262,928 USD, plus equity." }), config)).toMatchObject({ min: 184050, max: 262928 });
  });

  it("reads an hourly rate of the description as a salary, converted to EUR per year", () => {
    const sprachwerk = "Location: Work from home\nRate: 18 USD per hour (rates vary per country. If you are based elsewhere, the rates will be different)\nHelp shape AI";
    expect(normalizeSalary(draft({ description: sprachwerk }), config)).toMatchObject({
      origin: "description",
      currency: "USD",
      period: "hour",
      perYear: { min: 37440, max: 37440 },
      eurPerYear: { min: Math.round(37440 * 0.86), max: Math.round(37440 * 0.86) },
      qualityStatus: "valid",
      otherRegion: "currency",
    });
  });

  it("marks a salary as possibly another region's pay by its currency or by what the JD says", () => {
    expect(salary("€80,000 - €100,000 per year")?.otherRegion).toBeUndefined();
    expect(salary("$160K - $200K")?.otherRegion).toBe("currency");
    const qualcomm = "Pay Range And Other Compensation & Benefits\n€158,400 - €237,600\nThe above pay scale reflects the pay scale for the location for which it has been posted. Review details about our US benefits at this link.";
    expect(normalizeSalary(draft({ salaryText: "€158,400 - €237,600", description: qualcomm }), config)?.otherRegion).toBe("description");
    const local = pipelineWith((raw) => {
      (raw.salary as { local_currencies: string[] }).local_currencies = ["EUR", "USD"];
    });
    expect(normalizeSalary(draft({ salaryText: "$160K - $200K" }), local)?.otherRegion).toBeUndefined();
  });

  it("does not store an implausible description amount (a monthly €60)", () => {
    expect(normalizeSalary(draft({ description: "Salary: €60/month for the position" }), config)).toBeNull();
  });

  it("flags a stated amount that is implausible for its period", () => {
    expect(salary("€60/month")).toMatchObject({ qualityStatus: "review", reasonCodes: expect.arrayContaining(["AMOUNT_IMPLAUSIBLE_FOR_PERIOD"]) });
    expect(salary("€45/hour")?.reasonCodes).not.toContain("AMOUNT_IMPLAUSIBLE_FOR_PERIOD");
  });

  it("reads nothing from sentences without a salary word or without a currency", () => {
    expect(normalizeSalary(draft({ description: "We raised €50 million last year. Team of 85 people." }), config)).toBeNull();
    expect(normalizeSalary(draft({ description: "Your salary is competitive; we hire 25 people." }), config)).toBeNull();
  });

  it("is null when no salary is stated (C3)", () => {
    expect(normalizeSalary(draft(), config)).toBeNull();
  });
});

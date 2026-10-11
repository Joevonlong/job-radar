// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildSalary } from "@/lib/pipeline/salary";
import { isSalaryDerived, salaryDraft, withSalarySignal, type SignalDraft } from "@/lib/signals";

import { candidatesOf, shippedInterests, shippedPipeline } from "./helpers";

const pipeline = shippedPipeline();
const interests = shippedInterests();
const salary = (raw: string, min: number | null, max: number | null, origin: "channel" | "text" | "description" = "channel", currency = "EUR", period: "year" | "month" = "year") =>
  buildSalary({ raw, currency, period, min, max, periodAssumed: false, origin }, pipeline);

describe("salaryDraft: the T1 of a job's salary", () => {
  it("quotes the source field's text, marked structured, with per-year amounts", () => {
    const draft = salaryDraft(salary("€75,000.00/yr - €100,000.00/yr", 75000, 100000), "Some JD", interests, pipeline);
    expect(draft).toMatchObject({
      tier: "T1",
      kind: "salary_range",
      quote: "€75,000.00/yr - €100,000.00/yr",
      quoteOffset: null,
      quoteSource: "structured",
      extractor: "rule",
      value: { currency: "EUR", min: 75000, max: 100000, eurPerYear: { min: 75000, max: 100000 }, stated: { min: 75000, max: 100000, period: "year" }, periodAssumed: false, fromSalary: true },
    });
    expect(draft && isSalaryDerived(draft)).toBe(true);
  });

  it("converts a monthly salary and names the kind by the shape of the amount", () => {
    expect(salaryDraft(salary("€6,000 per month", 6000, 6000, "text", "EUR", "month"), "", interests, pipeline)).toMatchObject({ kind: "salary_fixed", value: { min: 72000, max: 72000, stated: { period: "month" } } });
    expect(salaryDraft(salary("up to €90k", null, 90000), "", interests, pipeline)).toMatchObject({ kind: "salary_max" });
    expect(salaryDraft(salary("from €90k", 90000, null), "", interests, pipeline)).toMatchObject({ kind: "salary_min" });
  });

  it("keeps a non-EUR amount in its currency, with the EUR figure and the other-region mark", () => {
    expect(salaryDraft(salary("$120,000 - $150,000", 120000, 150000, "channel", "USD"), "", interests, pipeline)).toMatchObject({
      value: { currency: "USD", min: 120000, max: 150000, eurPerYear: { min: 103200, max: 129000 }, otherRegion: "currency" },
    });
  });

  it("quotes a description salary from the description, and gives none when the quote is not in it", () => {
    const description = "Intro.\nSalary range: €60.000 - €80.000\nOutro";
    const found = salaryDraft(salary("Salary range: €60.000 - €80.000", 60000, 80000, "description"), description, interests, pipeline);
    expect(found).toMatchObject({ quoteSource: "description", quote: "Salary range: €60.000 - €80.000", quoteOffset: 7 });
    expect(salaryDraft(salary("Salary range: €60.000 - €80.000", 60000, 80000, "description"), "another text", interests, pipeline)).toBeNull();
  });

  it("gives none for salaries it cannot trust or that are too small", () => {
    expect(salaryDraft(null, "", interests, pipeline)).toBeNull();
    expect(salaryDraft(buildSalary({ raw: "2500-4", currency: "EUR", period: null, min: 2500, max: 4, periodAssumed: false, origin: "description" }, pipeline), "", interests, pipeline)).toBeNull();
    expect(salaryDraft(salary("€60/month", 60, 60, "text", "EUR", "month"), "", interests, pipeline)).toBeNull();
    expect(salaryDraft(salary("", 75000, 100000), "", interests, pipeline)).toBeNull();
  });

  it("clips a long source text to quote_max_chars", () => {
    const long = `Salary ${"x".repeat(500)}`;
    expect(salaryDraft(salary(long, 80000, 90000), "", interests, pipeline)?.quote).toHaveLength(interests.limits.quote_max_chars);
  });
});

describe("withSalarySignal", () => {
  const t1 = (min: number | null, max: number | null, over: Partial<SignalDraft> = {}): SignalDraft => ({
    tier: "T1",
    kind: "salary_range",
    value: { currency: "EUR", min, max, eurPerYear: { min, max }, stated: { min, max, period: "year" }, periodAssumed: false, currencyAssumed: false },
    quote: `q ${min}-${max}`,
    quoteOffset: 10,
    extractor: "rule",
    ...over,
  });
  const equity: SignalDraft = { tier: "T2", kind: "equity", value: null, quote: "equity", quoteOffset: 0, extractor: "rule" };
  const salarySignal = salaryDraft(salary("€80,000 - €100,000", 80000, 100000), "", interests, pipeline);

  it("puts the salary's T1 first and drops JD amounts inside its range", () => {
    const out = withSalarySignal(salarySignal, [equity, t1(100000, 100000), t1(80000, 100000), t1(null, 90000)]);
    expect(out).toEqual([salarySignal, equity]);
  });

  it("keeps a JD amount the salary does not cover, another currency, and every other tier", () => {
    const usd = t1(90000, 100000, { value: { ...(t1(1, 1).value as object), currency: "USD", min: 90000, max: 100000 } as SignalDraft["value"] });
    const out = withSalarySignal(salarySignal, [t1(150000, 150000), usd, equity]);
    expect(out).toEqual([salarySignal, t1(150000, 150000), usd, equity]);
  });

  it("keeps one of several identical amounts (a JD that says 'up to 70.000' three times)", () => {
    expect(withSalarySignal(null, [t1(null, 70000, { quoteOffset: 1 }), t1(null, 70000, { quoteOffset: 50 }), t1(null, 70000, { quoteOffset: 90 })])).toHaveLength(1);
  });

  it("is the JD signals unchanged without a salary signal", () => {
    expect(withSalarySignal(null, [t1(80000, 90000), equity])).toEqual([t1(80000, 90000), equity]);
  });

  it("drops a JD hit in the very sentence a description salary was quoted from", () => {
    const description = "Pay: €80,000 - €100,000 plus €150,000 OTE";
    const fromJd = salaryDraft(salary("Pay: €80,000 - €100,000", 80000, 100000, "description"), description, interests, pipeline);
    const hit = t1(150000, 150000, { quote: description, quoteOffset: 0 });
    expect(withSalarySignal(fromJd, [hit])).toEqual([fromJd]);
  });
});

describe("T1 rule candidates and benefit amounts", () => {
  const t1s = (text: string) => candidatesOf(text).filter((c) => c.tier === "T1");

  it("skips an amount whose nearest words are a benefit", () => {
    expect(t1s("Relocation support: up to €25,000 per year")).toHaveLength(0);
    expect(t1s("Mobile phone allowance of €3,000 per year")).toHaveLength(0);
    expect(t1s("Series B funding of $120,000,000 per year")).toHaveLength(0);
  });

  it("keeps a salary that mentions a benefit further away", () => {
    expect(t1s("Salary: €80,000 - €100,000 per year plus relocation support")).toHaveLength(1);
    expect(t1s("Base salary €90,000 per year. Learning budget on top.")).toHaveLength(1);
  });

  it("keeps an amount without any salary word (as before)", () => {
    expect(t1s("Das Gehalt: bis 70.000 € p.a.")).toHaveLength(1);
    expect(t1s("bis 70.000 € p.a.")).toHaveLength(1);
  });
});

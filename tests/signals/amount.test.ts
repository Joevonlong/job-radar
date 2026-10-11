import { describe, expect, it } from "vitest";

import { candidatesOf, pipelineWith, rawAmount, rawCategory, shippedInterests, shippedPipeline } from "./helpers";
import { revalueAmount } from "@/lib/signals/amount";
import { rulesFingerprint, valuationFingerprint } from "@/lib/signals";
import { findCandidates } from "@/lib/signals/rules";

const t1 = (text: string) => candidatesOf(text).filter((c) => c.tier === "T1");
const only = (text: string) => {
  const found = t1(text);
  expect(found, text).toHaveLength(1);
  const value = found[0]?.value;
  if (!value) throw new Error("T1 without a value");
  return value;
};

describe("T1 amounts", () => {
  it("reads euro ranges in the usual spellings", () => {
    expect(only("Salary: €85,000–105,000 per year")).toMatchObject({ currency: "EUR", min: 85000, max: 105000 });
    expect(only("Salary: EUR 90k - 110k p.a.")).toMatchObject({ currency: "EUR", min: 90000, max: 110000 });
    expect(only("We pay €85k-€105k.")).toMatchObject({ min: 85000, max: 105000 });
    expect(only("Compensation: 85 - 105k €")).toMatchObject({ min: 85000, max: 105000 });
  });

  it("reads German number formats and German wording", () => {
    expect(only("Das Jahresgehalt beträgt 85.000 € bis 95.000 € brutto.")).toMatchObject({ currency: "EUR", min: 85000, max: 95000 });
    expect(only("Gehalt: 70.000 - 90.000 EUR")).toMatchObject({ min: 70000, max: 90000 });
    expect(only("Wir bieten 90.000 Euro Jahresgehalt.")).toMatchObject({ min: 90000, max: 90000 });
  });

  it("reads up-to and from bounds", () => {
    expect(only("Salary up to €120,000 depending on experience")).toMatchObject({ min: null, max: 120000 });
    expect(only("Salary: from €70,000 per year")).toMatchObject({ min: 70000, max: null });
  });

  it("converts months to a year, keeps what the JD states", () => {
    const value = only("Monthly gross salary: EUR 7,200 (12 payments)");
    expect(value).toMatchObject({ currency: "EUR", min: 86400, max: 86400, stated: { min: 7200, max: 7200, period: "month" } });
    expect(value.eurPerYear).toEqual({ min: 86400, max: 86400 });
    expect(only("Gehalt: 6.500 € pro Monat")).toMatchObject({ min: 78000, stated: { period: "month" } });
  });

  it("keeps other currencies as stated, converts them with the shipped rate and marks them as possibly another region's pay", () => {
    const value = only("The base range for this position is $184,050 - $262,928 USD, plus equity.");
    expect(value).toMatchObject({ currency: "USD", min: 184050, max: 262928, eurPerYear: { min: Math.round(184050 * 0.86), max: Math.round(262928 * 0.86) }, otherRegion: "currency" });
    expect(only("Base salary $114,486–$163,552 per year")).toMatchObject({ min: 114486, max: 163552 });
    expect(only("The base range is $184,050 $262,928 plus equity.")).toMatchObject({ min: 184050, max: 262928 });
  });

  it("uses a configured rate when pipeline.yaml has one", () => {
    const pipeline = pipelineWith((raw) => {
      (raw.salary as { fx_rates: Record<string, number> }).fx_rates = { USD: 0.9 };
    });
    const found = findCandidates("Base salary $100,000 per year", shippedInterests(), pipeline).filter((c) => c.tier === "T1");
    expect(found[0]?.value?.eurPerYear).toEqual({ min: 90000, max: 90000 });
  });

  it("drops amounts below the minimum annual value (noise like a €50 voucher or a €2,000 pension contribution)", () => {
    expect(t1("A 50€ voucher every month")).toHaveLength(0);
    expect(t1("Betriebliche Altersvorsorge (€2.000 jährlich)")).toHaveLength(0);
    expect(t1("Learning budget of €1,500 per year")).toHaveLength(0);
    // hourly rates are annualized before the check
    expect(t1("Rate: 12 EUR per hour")).toHaveLength(1);
    const strict = shippedInterests((raw) => {
      rawAmount(raw).min_annual = 100000;
    });
    expect(candidatesOf("Salary €85,000–95,000 per year", strict).filter((c) => c.tier === "T1")).toHaveLength(0);
  });

  it("drops company figures, bonuses and amounts without a period it cannot place", () => {
    expect(t1("We have raised $1.4bn and have over $400M in revenue.")).toHaveLength(0);
    expect(t1("A signing bonus of €25,000 is possible")).toHaveLength(0);
    expect(t1("Mitarbeitende-werben-Mitarbeitende-Programm (mit Prämien bis zu 8.000 €)")).toHaveLength(0);
    expect(t1("The conference has 120 attendees")).toHaveLength(0);
  });

  it("keeps a salary that is followed by a bonus mention", () => {
    expect(only("Salary €90k plus a 10% bonus")).toMatchObject({ min: 90000 });
  });

  it("assumes a currency only next to a salary word, and only when configured", () => {
    expect(only("Salary up to 120k")).toMatchObject({ currency: "EUR", max: 120000, currencyAssumed: true });
    expect(t1("You will support up to 120k users")).toHaveLength(0);
    const none = shippedInterests((raw) => {
      rawAmount(raw).assume_currency = null;
    });
    expect(candidatesOf("Salary up to 120k", none).filter((c) => c.tier === "T1")).toHaveLength(0);
  });

  it("names the kind after the shape of the amount", () => {
    expect(t1("Salary €80,000 - €120,000 gross a year")[0]?.kind).toBe("salary_range");
    expect(t1("Salary €90,000 gross a year")[0]?.kind).toBe("salary_fixed");
    expect(t1("Salary up to €120,000")[0]?.kind).toBe("salary_max");
    expect(t1("Salary from €70,000")[0]?.kind).toBe("salary_min");
  });

  it("stays quiet on the shipped pipeline defaults for a JD without money", () => {
    expect(findCandidates("We build things. Join our team of 25 people in Berlin.", shippedInterests(), shippedPipeline())).toEqual([]);
  });
});

describe("valuation settings", () => {
  it("leave the rule fingerprint alone: rates, local currencies, other-region phrases and weight never force a rescan", () => {
    const base = rulesFingerprint(shippedInterests(), shippedPipeline());
    const rates = pipelineWith((raw) => {
      const salary = raw.salary as Record<string, unknown>;
      salary.fx_rates = { USD: 0.5 };
      salary.local_currencies = ["EUR", "CHF"];
      salary.other_region_patterns = ["\\bsomewhere else\\b"];
    });
    const weight = shippedInterests((raw) => {
      rawAmount(raw).other_region_weight = 5;
    });
    expect(rulesFingerprint(weight, rates)).toBe(base);
    expect(valuationFingerprint(rates)).not.toBe(valuationFingerprint(shippedPipeline()));
    const vocabulary = shippedInterests((raw) => {
      (rawCategory(raw, "T2").keywords as string[]).push("phantom stock");
    });
    expect(rulesFingerprint(vocabulary, shippedPipeline())).not.toBe(base);
  });

  it("revalueAmount works a stored amount out again with the current rates", () => {
    const value = only("The base range is $100,000 - $120,000 per year");
    const cheap = pipelineWith((raw) => {
      (raw.salary as { fx_rates: Record<string, number> }).fx_rates = { USD: 0.5 };
    });
    expect(revalueAmount(value, cheap, null)).toMatchObject({ min: 100000, max: 120000, eurPerYear: { min: 50000, max: 60000 }, otherRegion: "currency" });
    const local = pipelineWith((raw) => {
      (raw.salary as { local_currencies: string[] }).local_currencies = ["EUR", "USD"];
    });
    expect(revalueAmount(value, local, null).otherRegion).toBeUndefined();
  });
});

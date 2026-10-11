import { describe, expect, it } from "vitest";

import { computeRankValue } from "@/lib/scoring/rank";
import { annualEurTop, bonusPolicy, isHighPayAmount, isHighPaySignal, signalBonus } from "@/lib/signals/bonus";

import { candidatesOf, rawAmount, rawCategory, shippedInterests } from "./helpers";

const config = shippedInterests();

describe("signalBonus", () => {
  it("adds the weight of each tier present, once", () => {
    expect(signalBonus(["T3"], config).bonus).toBe(3);
    expect(signalBonus(["T3", "T3", "T3"], config).bonus).toBe(3);
    expect(signalBonus(["T1", "T4"], config)).toMatchObject({ sum: 12, bonus: 12, capped: false });
  });

  it("caps the total at bonus_cap (default 15)", () => {
    const all = signalBonus(["T1", "T2", "T3", "T4"], config);
    expect(all.sum).toBe(23);
    expect(all.bonus).toBe(15);
    expect(all.capped).toBe(true);
    expect(signalBonus(["T1", "T2"], config)).toMatchObject({ sum: 18, bonus: 15, capped: true });
  });

  it("gives benefit tags and unknown tiers no points", () => {
    expect(signalBonus(["tag", "tag", "T9"], config).bonus).toBe(0);
    expect(signalBonus([], config).bonus).toBe(0);
  });

  it("follows edited weights and cap", () => {
    const edited = shippedInterests((raw) => {
      rawCategory(raw, "T3").weight = 6;
      raw.bonus_cap = 7;
    });
    expect(signalBonus(["T3"], edited).bonus).toBe(6);
    expect(signalBonus(["T3", "T4"], edited)).toMatchObject({ sum: 8, bonus: 7 });
  });
});

describe("rank value (computeRankValue with this bonus)", () => {
  it("is match score + bonus, capped by bonus_cap", () => {
    const bonus = signalBonus(["T1", "T2", "T3"], config).bonus;
    expect(bonus).toBe(15);
    expect(computeRankValue(70, bonus, config.bonus_cap)).toBe(85);
    expect(computeRankValue(92, bonus, config.bonus_cap)).toBe(107);
  });
});

// ---------------------------------------------------------------- T1 only counts at or above the salary floor

/** The pay lines of the 18 Sprachwerk "AI Data Specialist" jobs of the smoke run (jobs 11-32). */
const SPRACHWERK_JD = "Job Type: Freelance\nLocation: Work from home\nWork Schedule: Part-time - 10+ hours per week.\nStart Date: Immediately\nDuration: TBC\nRate: 15 USD/Hour\nHelp Shape the Future of AI";

const t1Of = (text: string) => {
  const found = candidatesOf(text).find((c) => c.tier === "T1");
  if (!found) throw new Error("no T1 in text");
  return found;
};
const withFloor = (floor: number | null, edit: (raw: Record<string, unknown>) => void = () => {}) => {
  const interests = shippedInterests(edit);
  return { interests, policy: bonusPolicy(interests, floor, "EUR") };
};

describe("T1 bonus needs a high-pay amount", () => {
  it("Sprachwerk '$15/hour': the amount is extracted and shown, but brings no T1 bonus under a 70k floor", () => {
    const sprachwerk = t1Of(SPRACHWERK_JD);
    expect(sprachwerk.value).toMatchObject({ currency: "USD", min: 31200, max: 31200, stated: { period: "hour" } });
    const { interests, policy } = withFloor(70000);
    expect(isHighPayAmount(sprachwerk.value, policy)).toBe(false);
    expect(signalBonus([{ tier: "T1", value: sprachwerk.value }], interests, policy)).toMatchObject({ bonus: 0, categories: [], amountBelowThreshold: true, amountMinAnnualEur: 70000 });
    // T3 still counts next to a muted amount
    expect(signalBonus([{ tier: "T1", value: sprachwerk.value }, { tier: "T3" }], interests, policy)).toMatchObject({ bonus: 3, amountBelowThreshold: true });
  });

  it("uses the annual upper bound: a range crossing the floor counts, one entirely below does not", () => {
    const { interests, policy } = withFloor(70000);
    expect(signalBonus([{ tier: "T1", value: t1Of("Salary €60,000 - €80,000 per year").value }], interests, policy).bonus).toBe(10);
    expect(signalBonus([{ tier: "T1", value: t1Of("Salary €50,000 - €65,000 per year").value }], interests, policy)).toMatchObject({ bonus: 0, amountBelowThreshold: true });
    expect(signalBonus([{ tier: "T1", value: t1Of("Salary up to €69,999 per year").value }], interests, policy).bonus).toBe(0);
    expect(signalBonus([{ tier: "T1", value: t1Of("Salary up to €70,000 per year").value }], interests, policy).bonus).toBe(10);
  });

  it("a monthly figure is compared per year", () => {
    const { interests, policy } = withFloor(70000);
    expect(signalBonus([{ tier: "T1", value: t1Of("Monthly gross salary: EUR 7,200").value }], interests, policy).bonus).toBe(10); // 86,400
    expect(signalBonus([{ tier: "T1", value: t1Of("Gehalt: 4.500 € pro Monat").value }], interests, policy).bonus).toBe(0); // 54,000
  });

  it("converts other currencies with the rough table, prefers pipeline.yaml's rate, and counts a currency it cannot compare", () => {
    // other regions' amounts keep points here, so only the floor decides
    const { interests, policy } = withFloor(70000, (raw) => {
      rawAmount(raw).other_region_weight = 10;
    });
    const usd = t1Of("The base range is $70,000 - $75,000 per year").value; // 75,000 USD * 0.86 = 64,500 EUR
    expect(signalBonus([{ tier: "T1", value: usd }], interests, policy).bonus).toBe(0);
    expect(signalBonus([{ tier: "T1", value: t1Of("The base range is $90,000 - $100,000 per year").value }], interests, policy).bonus).toBe(10);
    expect(annualEurTop({ max: 100, currency: "SEK" }, policy)).toBeNull();
    expect(isHighPayAmount({ max: 100, currency: "SEK" }, policy)).toBe(true);
    expect(annualEurTop({ max: 75000, currency: "USD", eurPerYear: { min: 70000, max: 80000 } }, policy)).toBe(80000);
  });

  it("an amount that is possibly another region's pay brings other_region_weight points (default none) and is no high-pay signal", () => {
    const usd = t1Of("The base range is $160,000 - $200,000 per year").value;
    const eur = t1Of("Salary €80,000 - €100,000 per year").value;
    expect(usd).toMatchObject({ otherRegion: "currency" });
    const { interests, policy } = withFloor(70000);
    expect(signalBonus([{ tier: "T1", value: usd }, { tier: "T3" }], interests, policy)).toMatchObject({ bonus: 3, categories: [{ id: "T3", points: 3 }], amountOtherRegion: true, amountBelowThreshold: false });
    expect(isHighPayAmount(usd, policy)).toBe(true);
    expect(isHighPaySignal(usd, policy)).toBe(false);
    expect(isHighPaySignal(eur, policy)).toBe(true);
    // a local amount next to it wins
    expect(signalBonus([{ tier: "T1", value: usd }, { tier: "T1", value: eur }], interests, policy)).toMatchObject({ bonus: 10, amountOtherRegion: false });
    // reduced points instead of none
    const reduced = withFloor(70000, (raw) => {
      rawAmount(raw).other_region_weight = 4;
    });
    expect(signalBonus([{ tier: "T1", value: usd }], reduced.interests, reduced.policy)).toMatchObject({ bonus: 4, categories: [{ id: "T1", points: 4 }], amountOtherRegion: true });
    expect(isHighPaySignal(usd, reduced.policy)).toBe(true);
    // still below the floor: the floor note, not the region note
    const low = t1Of("Rate: 18 USD per hour").value;
    expect(signalBonus([{ tier: "T1", value: low }], interests, policy)).toMatchObject({ bonus: 0, amountBelowThreshold: true, amountOtherRegion: false });
  });

  it("is configurable: salary_floor | a number | none; an unknown floor means no minimum", () => {
    const sprachwerk = t1Of(SPRACHWERK_JD).value;
    const T1 = [{ tier: "T1", value: sprachwerk }];
    const run = (rule: string | number, floor: number | null) => {
      const { interests, policy } = withFloor(floor, (raw) => {
        rawAmount(raw).bonus_requires_at_least = rule;
        rawAmount(raw).other_region_weight = 10; // USD: only the floor rule decides here
      });
      return signalBonus(T1, interests, policy).bonus;
    };
    expect(run("salary_floor", 70000)).toBe(0);
    expect(run("salary_floor", 20000)).toBe(10); // 26,832 EUR >= 20,000
    expect(run("salary_floor", null)).toBe(10);
    expect(run(25000, 70000)).toBe(10); // a number replaces the floor
    expect(run(40000, 10000)).toBe(0);
    expect(run("none", 70000)).toBe(10);
  });

  it("defaults to salary_floor", () => {
    const amount = shippedInterests().signals.categories.find((c) => c.kind === "amount");
    expect(amount?.kind === "amount" ? amount.amount.bonus_requires_at_least : null).toBe("salary_floor");
  });
});

describe("signalBonus with user-defined categories", () => {
  const custom = shippedInterests((raw) => {
    const categories = (raw.signals as { categories: Array<Record<string, unknown>>; retired_categories: unknown[] }).categories;
    categories.push({ id: "visa", kind: "keyword", label: { en: "Visa" }, color: "violet", weight: 4, ai_definition: "visa sponsorship", keywords: ["visa sponsorship"] });
    categories.push({ id: "remote", kind: "tag", label: { en: "Remote" }, color: "olive", weight: 2, tags: ["remote budget"] });
    const index = categories.findIndex((c) => c.id === "T3");
    const [t3] = categories.splice(index, 1);
    (raw.signals as { retired_categories: unknown[] }).retired_categories = [t3];
  });

  it("adds the weight of every active category once, in category order", () => {
    expect(signalBonus(["visa", "T2", "visa"], custom)).toMatchObject({ sum: 12, categories: [{ id: "T2", points: 8 }, { id: "visa", points: 4 }] });
  });

  it("counts a tag category only when it has a weight", () => {
    expect(signalBonus(["remote", "tag"], custom)).toMatchObject({ sum: 2, categories: [{ id: "remote", points: 2 }] });
  });

  it("gives a deleted (retired) or unknown category nothing", () => {
    expect(signalBonus(["T3", "gone"], custom)).toMatchObject({ sum: 0, categories: [] });
  });

  it("has no amount rule without an amount category", () => {
    const noAmount = shippedInterests((raw) => {
      const categories = (raw.signals as { categories: Array<Record<string, unknown>> }).categories;
      categories.splice(categories.findIndex((c) => c.id === "T1"), 1);
    });
    expect(bonusPolicy(noAmount, 70000)).toMatchObject({ amountId: null, minAnnualEur: null });
    expect(signalBonus([{ tier: "T1", value: { max: 10, currency: "EUR" } }, { tier: "T2" }], noAmount, bonusPolicy(noAmount, 70000))).toMatchObject({ sum: 8, amountBelowThreshold: false });
  });
});

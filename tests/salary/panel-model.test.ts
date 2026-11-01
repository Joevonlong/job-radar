import { describe, expect, it } from "vitest";

import { aiResultOf, groupFigures, groupRowIsCombined, groupStatus, rulerFigures, versusMedian } from "@/components/jobs/detail/salary-panel-model";
import { salaryLookupResultSchema } from "@/lib/salary/lookup-types";
import type { SalaryContext, SalaryLookupView } from "@/lib/salary/view";

const context = (over: Partial<SalaryContext> = {}): SalaryContext => ({
  state: "ok", currency: "EUR", familyId: "software", familyLabel: "Software", figure: 90000,
  group: { level: "family", seniority: null, place: null, n: 3, median: 90000, quantiles: [80000, 90000, 100000] }, position: null,
  company: { count: 0, median: null, minSample: 3, figures: [] }, links: [], staleAi: false, benchmarkEnabled: true, benchmarkComputed: true,
  lookup: { availability: "enabled", unrestricted: false, providers: [], latest: null, initialRequest: null, usedToday: 0, maxPerDay: 3, ttlDays: 30 },
  ...over,
});

const band = { title: "Engineer", seniority: null, location: null, basis: "base", min: 80000, max: 100000, median: 90000, convertible: true, original: { min: 80000, max: 100000, median: 90000, currency: "EUR" }, sources: [] };
const view = (over: Record<string, unknown>): SalaryLookupView => ({
  id: 1, origin: null, provider: null, model: null, fetchedAt: "2026-01-01T00:00:00.000Z", expired: false,
  result: salaryLookupResultSchema.parse({
    query: { company: "Acme", title: "Engineer", seniority: "senior", city: null, country: null, currency: "EUR" },
    companyLevel: { level: "market", median: null, summary: "", sources: [] },
    roleBand: band, relatedRoles: [], sources: [], confidence: "medium", notes: "", dropped: 0, observations: [], ...over,
  }),
});

describe("groupFigures", () => {
  it("merges equal figures into one point with a count, ascending", () => {
    expect(groupFigures([95000, 82000, 88000, 88000, 95000, 88000])).toEqual([
      { value: 82000, count: 1 },
      { value: 88000, count: 3 },
      { value: 95000, count: 2 },
    ]);
    expect(groupFigures([])).toEqual([]);
  });
});

describe("groupStatus", () => {
  it("keeps the order in which one reason wins over another", () => {
    expect(groupStatus(context({ state: "config_error", currency: "", familyId: null, staleAi: true }))).toBe("config_error");
    expect(groupStatus(context({ state: "not_ready", currency: "" }))).toBe("not_ready");
    expect(groupStatus(context({ currency: "", familyId: null }))).toBe("no_currency");
    expect(groupStatus(context({ familyId: null, staleAi: true, benchmarkEnabled: false }))).toBe("no_family");
    expect(groupStatus(context({ group: null, staleAi: true, benchmarkEnabled: false }))).toBe("stale");
    expect(groupStatus(context({ group: null, staleAi: true, benchmarkComputed: false }))).toBe("not_computed");
    expect(groupStatus(context({ group: null, benchmarkComputed: false }))).toBe("not_computed");
    expect(groupStatus(context({ group: null }))).toBe("no_group");
    expect(groupStatus(context())).toBe("group");
  });

  it("merges the group and company rows only when neither can be computed", () => {
    expect(groupRowIsCombined(context({ state: "config_error" }))).toBe(true);
    expect(groupRowIsCombined(context({ currency: "" }))).toBe(true);
    expect(groupRowIsCombined(context({ familyId: null, group: null }))).toBe(false);
  });
});

describe("versusMedian", () => {
  it("compares the posting's own figure with the group median in whole percent", () => {
    expect(versusMedian(99000, 90000)).toBe(10);
    expect(versusMedian(81000, 90000)).toBe(-10);
    expect(versusMedian(90000, 90000)).toBe(0);
  });
  it("is null without a figure or a median", () => {
    expect(versusMedian(null, 90000)).toBeNull();
    expect(versusMedian(90000, null)).toBeNull();
    expect(versusMedian(90000, 0)).toBeNull();
  });
});

describe("aiResultOf", () => {
  it("is only a band when the lookup has the role's band", () => {
    expect(aiResultOf(null)).toEqual({ kind: "none" });
    expect(aiResultOf(view({}))).toMatchObject({ kind: "band", min: 80000, max: 100000, median: 90000 });
  });

  it("never puts the company-wide median where the role's band belongs", () => {
    const noBand = aiResultOf(view({ roleBand: null, companyLevel: { level: "above", median: 150000, summary: "", sources: [] } }));
    expect(noBand).toEqual({ kind: "no_band" });
    expect(rulerFigures({ jd: null, group: null, company: [], ai: noBand, floor: null }).filter((value) => value !== null)).toEqual([]);
  });

  it("tells a lookup with no figure at all from one with only company figures", () => {
    expect(aiResultOf(view({ roleBand: null }))).toEqual({ kind: "empty" });
  });

  it("keeps a band in another currency out of the drawing", () => {
    const foreign = aiResultOf(view({ roleBand: { ...band, convertible: false, min: null, max: null, median: null, original: { min: 90000, max: 110000, median: null, currency: "USD" } } }));
    expect(foreign.kind).toBe("text_only");
    expect(rulerFigures({ jd: null, group: null, company: [], ai: foreign, floor: null }).filter((value) => value !== null)).toEqual([]);
  });
});

describe("rulerFigures", () => {
  it("collects what every drawn row puts on the scale, the floor included", () => {
    const figures = rulerFigures({
      jd: { min: 85000, max: 105000 },
      group: { quantiles: [70000, 86000, 108000], median: 86000 },
      company: [82000, 95000],
      ai: aiResultOf(view({})),
      floor: 75000,
    });
    expect(figures.filter((value): value is number => value !== null).sort((a, b) => a - b)).toEqual([70000, 75000, 80000, 82000, 85000, 86000, 90000, 95000, 100000, 105000, 108000]);
  });
});

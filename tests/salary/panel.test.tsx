import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { SalaryPanel } from "@/components/jobs/detail/salary-panel";
import type { JobSalary } from "@/lib/domain/types";
import { salaryLookupResultSchema } from "@/lib/salary/lookup-types";
import type { SalaryContext, SalaryLookupView } from "@/lib/salary/view";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

vi.mock("@/app/jobs/[id]/salary-actions", () => ({ lookupSalaryAction: vi.fn(), salaryLookupStatusAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const AXIS = { minK: 40, maxK: 200, tickStepK: 20, currency: "EUR" };

const context = (over: Partial<SalaryContext> = {}): SalaryContext => ({
  state: "ok", currency: "EUR", familyId: "software", familyLabel: "Software",
  figure: 99000,
  group: { level: "family", seniority: null, place: null, n: 12, median: 90000, quantiles: [70000, 90000, 110000] },
  position: { value: 58, clamp: null },
  company: { count: 3, median: 92000, minSample: 2, figures: [82000, 92000, 95000] },
  links: [{ id: "levels", label: "Levels.fyi", url: "https://example.org/levels" }],
  staleAi: false, benchmarkEnabled: true, benchmarkComputed: true,
  lookup: { availability: "enabled", unrestricted: false, providers: ["claude-cli"], latest: null, initialRequest: null, usedToday: 0, maxPerDay: 3, ttlDays: 30 },
  ...over,
});

const salary = (over: Partial<JobSalary> = {}): JobSalary => ({
  raw: "€90-108k", currency: "EUR", period: "year", min: 90000, max: 108000, perYear: { min: 90000, max: 108000 },
  basePerYear: { min: 90000, max: 108000 }, baseCurrency: "EUR", eurPerYear: { min: 90000, max: 108000 },
  periodAssumed: false, origin: "channel", qualityStatus: "valid", reasonCodes: [], otherRegion: null, includesVariable: false, ...over,
});

const band = { title: "Engineer", seniority: "senior", location: null, basis: "base", min: 120000, max: 150000, median: 135000, convertible: true, original: { min: 120000, max: 150000, median: 135000, currency: "EUR" }, sources: [0] };
const lookup = (over: Record<string, unknown> = {}): SalaryLookupView => ({
  id: 1, origin: { jobId: 7, title: "Engineer" }, provider: "seed", model: "seed", fetchedAt: "2026-01-01T12:00:00.000Z", expired: false,
  result: salaryLookupResultSchema.parse({
    query: { company: "Acme", title: "Engineer", seniority: "senior", city: null, country: null, currency: "EUR" },
    companyLevel: { level: "above", median: 140000, summary: "Pays well", sources: [0] },
    roleBand: band, relatedRoles: [],
    sources: [{ url: "https://salary.example.org/roles", host: "salary.example.org", site: "Salary site", title: "Pay", excerpt: "Example", trusted: true }],
    confidence: "medium", notes: "", dropped: 0, observations: [], ...over,
  }),
});

interface Over { context?: Partial<SalaryContext>; salary?: JobSalary | null; salaryDisclosed?: boolean; normalizedText?: string | null; floor?: number | null }
const show = (over: Over = {}, locale: "en" | "zh" = "en") =>
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh} timeZone="UTC">
      <SalaryPanel
        context={context(over.context)}
        salary={over.salary === undefined ? salary() : over.salary}
        salaryDisclosed={over.salaryDisclosed ?? true}
        normalizedText={over.normalizedText === undefined ? "€90–108k" : over.normalizedText}
        floor={over.floor === undefined ? 75000 : over.floor}
        axis={AXIS}
        jobId={7}
        company="Acme"
        timeZone="UTC"
      />
    </NextIntlClientProvider>,
  );

describe("the panel: one heading, three cells, one ruler", () => {
  it("replaces the two old cards by a single section with the anchor and heading", () => {
    show();
    expect(screen.getByRole("heading", { level: 2, name: "Salary · what this job pays" })).toHaveAttribute("id", "h-pay");
    expect(screen.queryByTestId("salary-level-card")).toBeNull();
    expect(screen.queryByTestId("salary-lookup-card")).toBeNull();
    expect(screen.getAllByTestId("salary-panel")).toHaveLength(1);
  });

  it("the three cells show the posting's range, the group median and the AI range", () => {
    show({ context: { lookup: { ...context().lookup, latest: lookup() } } });
    expect(screen.getByTestId("salary-head-jd-figure")).toHaveTextContent("€90–108k/yr");
    expect(screen.getByTestId("salary-head-group-median")).toHaveTextContent("Median €90k");
    expect(screen.getByTestId("salary-head-group-position")).toHaveTextContent("above 58% of the group");
    expect(screen.getByTestId("salary-head-ai-figure")).toHaveTextContent("€120–150k");
    expect(screen.getByTestId("salary-head-ai")).toHaveTextContent("unverified");
    expect(screen.getByTestId("salary-head-ai")).toHaveTextContent("Company overall: Above the market");
  });

  it("the percentage against the median uses the posting's own figure only: a very high AI band changes nothing", () => {
    show();
    const without = screen.getByTestId("salary-head-jd-vs").textContent;
    expect(without).toBe("10% above the similar-postings median");
    document.body.innerHTML = "";
    show({ context: { lookup: { ...context().lookup, latest: lookup({ roleBand: { ...band, min: 500000, max: 900000, median: 700000 }, companyLevel: { level: "top", median: 800000, summary: "", sources: [0] } }) } } });
    expect(screen.getByTestId("salary-head-jd-vs")).toHaveTextContent(without ?? "");
  });

  it("says 'below' and 'on' the median", () => {
    show({ context: { figure: 81000 } });
    expect(screen.getByTestId("salary-head-jd-vs")).toHaveTextContent("10% below the similar-postings median");
    document.body.innerHTML = "";
    show({ context: { figure: 90000 } });
    expect(screen.getByTestId("salary-head-jd-vs")).toHaveTextContent("On the similar-postings median");
  });
});

describe("the ruler is accessible by its text", () => {
  it("is a labelled list; each row's text carries its figures; the drawing is hidden", () => {
    show({ context: { lookup: { ...context().lookup, latest: lookup() } } });
    const list = screen.getByRole("list", { name: "Salary by source, on one scale" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual(["salary-lane-jd", "salary-lane-group", "salary-lane-company", "salary-lane-ai"]);
    expect(rows[0]).toHaveTextContent("This posting");
    expect(rows[0]).toHaveTextContent("JD text · fact");
    expect(rows[0]).toHaveTextContent("€90–108k/yr");
    expect(rows[1]).toHaveTextContent("Median €90k, P10–P90 €70k–€110k");
    expect(rows[1]).toHaveTextContent("Software · all levels · all places · 12 postings");
    expect(rows[2]).toHaveTextContent("3 postings: €82k, €92k, €95k, median €92k");
    expect(rows[3]).toHaveTextContent("€120–150k, median €135k");
    expect(rows[3]).toHaveTextContent("AI web search · unverified");
    for (const kind of ["jd", "group", "company", "ai"]) expect(screen.getByTestId(`salary-track-${kind}`)).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("salary-ruler-ticks").parentElement).toHaveAttribute("aria-hidden", "true");
  });

  it("writes the floor as visible text and draws it on every track", () => {
    show();
    expect(screen.getByTestId("salary-ruler-floor")).toHaveTextContent("Your floor €75k");
    expect(document.querySelectorAll('[data-mark="floor"]')).toHaveLength(3);
  });

  it("draws no floor line and no floor text without a floor", () => {
    show({ floor: null });
    expect(screen.queryByTestId("salary-ruler-floor")).toBeNull();
    expect(document.querySelectorAll('[data-mark="floor"]')).toHaveLength(0);
  });

  it("counts the rows that are drawn", () => {
    show({ context: { company: { count: 0, median: null, minSample: 2, figures: [] } } });
    expect(screen.getByRole("heading", { level: 2 }).parentElement).toHaveTextContent("2 sources");
  });
});

describe("the company's other postings", () => {
  const company = (figures: number[], median: number | null) => ({ company: { count: figures.length, median, minSample: 3, figures } });

  it.each([
    ["en", "3 postings: €82k, €92k, €95k, median €92k"],
    ["zh", "3 条：€82k、€92k、€95k，中位 €92k"],
  ] as const)("%s: the list and the clauses use that language's separators", (locale, text) => {
    show({ context: company([82000, 92000, 95000], 92000) }, locale);
    expect(screen.getByTestId("salary-lane-company")).toHaveTextContent(text);
  });

  it("none: says so and draws nothing", () => {
    show({ context: company([], null) });
    const row = screen.getByTestId("salary-lane-company");
    expect(row).toHaveAttribute("data-state", "none");
    expect(row).toHaveTextContent("No other posting at this company states a salary.");
    expect(row.querySelector("[data-mark]")).toBeNull();
  });

  it("one: a single point, no median", () => {
    show({ context: company([88000], null) });
    const row = screen.getByTestId("salary-lane-company");
    expect(row.querySelectorAll('[data-mark="point"]')).toHaveLength(1);
    expect(row.querySelector('[data-mark="median"]')).toBeNull();
    expect(row).toHaveTextContent("1 posting: €88k, too few for a median (at least 3)");
  });

  it("below the sample size: points, no median, says why", () => {
    show({ context: company([82000, 95000], null) });
    const row = screen.getByTestId("salary-lane-company");
    expect(row).toHaveAttribute("data-state", "few");
    expect(row.querySelectorAll('[data-mark="point"]')).toHaveLength(2);
    expect(row).toHaveTextContent("too few for a median");
  });

  it("equal figures become one point with a count", () => {
    show({ context: company([88000, 88000, 95000], 88000) });
    const row = screen.getByTestId("salary-lane-company");
    const points = row.querySelectorAll('[data-mark="point"]');
    expect(points).toHaveLength(2);
    expect(points[0]).toHaveAttribute("data-count", "2");
    expect(row).toHaveTextContent("3 postings: €88k ×2, €95k, median €88k");
    expect(row.querySelector('[data-mark="median"]')).not.toBeNull();
  });
});

describe("the posting's own salary", () => {
  it("none disclosed: the cell and the row say so, nothing is drawn, never 0", () => {
    show({ salary: null, salaryDisclosed: false, normalizedText: null, context: { figure: null, position: null } });
    expect(screen.getByTestId("salary-head-jd")).toHaveTextContent("Not disclosed");
    expect(screen.getByTestId("salary-lane-jd")).toHaveAttribute("data-state", "none");
    expect(screen.getByTestId("salary-level-no-figure")).toHaveTextContent("states no salary that can be compared");
    expect(screen.queryByTestId("salary-head-jd-vs")).toBeNull();
    expect(screen.getByTestId("salary-panel")).not.toHaveTextContent(/\b0\b|NaN/);
  });

  it("to be reviewed: the cell says so and nothing is drawn, as the year card", () => {
    show({ salary: salary({ qualityStatus: "review" }), context: { figure: null } });
    expect(screen.getByTestId("salary-head-jd")).toHaveTextContent("Salary needs review");
    expect(screen.getByTestId("salary-lane-jd")).toHaveAttribute("data-state", "review");
    expect(screen.queryByTestId("salary-lane-jd-block")).toBeNull();
  });

  it("another currency or region: the posting's wording only, not drawn, not compared", () => {
    show({ salary: salary({ otherRegion: "currency", currency: "USD", basePerYear: { min: 120000, max: 140000 } }), normalizedText: "$140–160k", context: { figure: null } });
    expect(screen.getByTestId("salary-head-jd")).toHaveTextContent("$140–160k");
    expect(screen.getByTestId("salary-head-jd")).toHaveTextContent("Another currency or region: not compared");
    expect(screen.getByTestId("salary-lane-jd")).toHaveAttribute("data-state", "other");
    expect(screen.queryByTestId("salary-lane-jd-block")).toBeNull();
    expect(screen.queryByTestId("salary-head-jd-vs")).toBeNull();
  });

  it("a base figure in a currency other than the panel's counts as another currency", () => {
    show({ salary: salary({ baseCurrency: "GBP" }), normalizedText: "£80–90k", context: { figure: null } });
    expect(screen.getByTestId("salary-lane-jd")).toHaveAttribute("data-state", "other");
  });

  it("a stated range below the floor is drawn grey", () => {
    show({ salary: salary({ basePerYear: { min: 50000, max: 60000 } }), floor: 75000 });
    expect(screen.getByTestId("salary-lane-jd-block")).toHaveAttribute("data-tone", "jd-muted");
  });
});

describe("the similar-postings row", () => {
  it.each([
    [{ state: "config_error" }, "salary-level-config-error", "Settings unreadable"],
    [{ state: "not_ready" }, "salary-level-not-ready", "Tables missing"],
    [{ currency: "" }, "salary-level-no-currency", "No base currency"],
    [{ familyId: null, group: null }, "salary-level-no-family", "No role family"],
    [{ group: null, staleAi: true, benchmarkEnabled: false }, "salary-level-stale-ai", "Comparison being rebuilt"],
    [{ group: null, benchmarkComputed: false }, "salary-level-not-computed", "Not computed yet"],
    [{ group: null }, "salary-level-no-group", "Too few postings"],
  ] as const)("%j: the row gives the reason and the cell its short form", (over, testId, head) => {
    show({ context: over as Partial<SalaryContext> });
    expect(screen.getByTestId(testId)).toBeVisible();
    expect(screen.getByTestId("salary-head-group")).toHaveTextContent(head);
    expect(screen.queryByTestId("salary-track-group")).toBeNull();
  });

  it("an unreadable configuration or a missing currency merges the group and company rows into one", () => {
    show({ context: { state: "config_error" } });
    expect(screen.queryByTestId("salary-lane-company")).toBeNull();
    expect(within(screen.getByRole("list", { name: "Salary by source, on one scale" })).getAllByRole("listitem")).toHaveLength(3);
  });

  it("keeps the stale-figures note when another reason wins, and does not repeat it", () => {
    show({ context: { familyId: null, group: null, staleAi: true, benchmarkEnabled: false } });
    expect(screen.getByTestId("salary-level-stale-ai")).toBeVisible();
    expect(screen.getByTestId("salary-level-no-family")).toBeVisible();
    expect(screen.queryByTestId("salary-level-not-computed")).toBeNull();
    document.body.innerHTML = "";
    show({ context: { group: null, staleAi: true, benchmarkEnabled: false } });
    expect(screen.getAllByTestId("salary-level-stale-ai")).toHaveLength(1);
  });

  it("the ordinary benchmark-off note shows with a group", () => {
    show({ context: { benchmarkEnabled: false } });
    expect(screen.getByTestId("salary-level-benchmark-off")).toHaveTextContent("turned off");
    expect(screen.getByTestId("salary-lane-group")).toHaveAttribute("data-state", "drawn");
  });

  it("states the clamp when the posting is outside the group's range", () => {
    show({ context: { position: { value: 100, clamp: "above" } } });
    expect(screen.getByTestId("salary-head-group-clamp")).toHaveAttribute("data-clamp", "above");
    expect(screen.getByTestId("salary-head-group-position")).toHaveTextContent("above the highest tenth");
  });
});

describe("links, both languages", () => {
  it.each(["en", "zh"] as const)("%s: the links open in a new tab, the empty state says why", (locale) => {
    show({}, locale);
    const link = screen.getByTestId("salary-link-levels");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    document.body.innerHTML = "";
    show({ context: { links: [] } }, locale);
    expect(screen.getByTestId("salary-panel")).toHaveTextContent(locale === "en" ? "No search links" : "没有设置搜索链接");
  });

  it("the Chinese panel carries the same structure", () => {
    show({ context: { lookup: { ...context().lookup, latest: lookup() } } }, "zh");
    expect(screen.getByRole("heading", { level: 2, name: "薪资 · 这个岗位给多少钱" })).toHaveAttribute("id", "h-pay");
    expect(screen.getByRole("list", { name: "各来源薪资对照" })).toBeVisible();
    expect(screen.getByTestId("salary-lane-ai")).toHaveTextContent("未核对");
    expect(screen.getByTestId("salary-head-jd-vs")).toHaveTextContent("比同类中位高 10%");
  });
});

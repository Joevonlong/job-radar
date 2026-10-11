import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: navigation.replace, push: vi.fn(), refresh: vi.fn() }) }));

import { InsightsPage } from "@/components/insights/insights-view";
import { insightsSchema } from "@/lib/config/schemas/insights";
import { buildInsightsView } from "@/lib/insights/view";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";
import { shippedYaml } from "../config/helpers";
import { emptyData } from "./helpers";
import { defaultCategoryViews } from "../signals/helpers";

const config = insightsSchema.parse(shippedYaml("insights.yaml"));
const window = { from: "2026-10-01", to: "2026-10-07" };

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
    {node}
  </NextIntlClientProvider>
);

function filledData() {
  const data = emptyData();
  data.daily = [
    { day: "2026-10-06", passed: 3, filtered: 2, avgRank: 70 },
    { day: "2026-10-07", passed: 1, filtered: 0, avgRank: 82 },
  ];
  data.previousTotal = 4;
  data.previousPassed = 3;
  data.sources = [
    { family: "ats", total: 4, passed: 3 },
    { family: "newfamily", total: 1, passed: 0 },
  ];
  data.cities = { total: 4, remote: 1, other: 1, cities: [{ city: "Berlin", count: 2 }, { city: "München", count: 1 }] };
  data.salary = { total: 4, disclosed: 2, comparable: 2, medianEurPerYear: 70_000, minSample: 5, buckets: [{ index: 6, count: 1 }, { index: 7, count: 1 }] };
  data.signals = {
    total: 4,
    tiers: [{ tier: "T1", jobs: 1, avgRank: 82 }, { tier: "T2", jobs: 0, avgRank: null }, { tier: "T3", jobs: 2, avgRank: 60 }, { tier: "T4", jobs: 0, avgRank: null }],
    withoutSignal: 1,
    highPay: 1,
    scored: 3,
    avgRank: 66.5,
  };
  data.scores = { atPushLine: 1, scored: 3, pending: 1, avgRank: 66.5, buckets: [{ index: 12, count: 2 }, { index: 16, count: 1 }] };
  data.funnel = { newJobs: 4, reached: { interested: 2, preparing: 1, applied: 1, interviewing: 0, offer: 0 }, exits: { rejected: 1, withdrawn: 0, archived: 0 } };
  data.filters = { total: 2, reasons: [{ code: "location_not_allowed", jobs: 2 }, { code: "old_code", jobs: 1 }] };
  return data;
}

const render7 = (data = filledData(), locale: "en" | "zh" = "en") =>
  render(wrap(<InsightsPage view={buildInsightsView({ data, config, rangeDays: 7, window, pushLine: 70, salaryFloorEur: 70_000, currency: "EUR", categories: defaultCategoryViews(locale).filter((c) => c.kind !== "tag"), highValueNames: ["Explicit amount", "Equity"] })} defaultRange={30} />, locale));

describe("InsightsPage", () => {
  it("shows one empty state when the range holds nothing", () => {
    render7(emptyData());
    expect(screen.getByTestId("insights-empty")).toHaveTextContent("No jobs in the last 7 days");
    expect(screen.queryByTestId("kpi-strip")).toBeNull();
    // the range switch stays so a longer range can be picked
    expect(screen.getByTestId("range-switch")).toBeInTheDocument();
  });

  it("switches the range in the URL; the default range has no parameter", async () => {
    render7();
    const radios = within(screen.getByTestId("range-switch")).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("data-range"))).toEqual(["7", "30", "90"]);
    expect(radios[0]).toBeChecked();
    expect(radios[1]).not.toBeChecked();
    navigation.replace.mockClear();
    await userEvent.click(radios[2] as HTMLElement);
    expect(navigation.replace).toHaveBeenLastCalledWith("/insights?range=90", { scroll: false });
    await userEvent.click(radios[1] as HTMLElement);
    expect(navigation.replace).toHaveBeenLastCalledWith("/insights", { scroll: false });
  });

  it("links the headline numbers to the matching /jobs filters", () => {
    render7();
    expect(screen.getByTestId("kpi-new-value")).toHaveTextContent("6");
    expect(screen.getByTestId("kpi-new-value")).toHaveAttribute("href", "/jobs?from=2026-10-01&to=2026-10-07&filtered=true&status=active&status=possibly_closed&status=closed");
    // the pass rate is the number, its count (4/6 · 67%) is the link
    expect(screen.getByTestId("kpi-passed-value")).toHaveTextContent("67%");
    expect(screen.getByTestId("kpi-passed-count")).toHaveAttribute("href", "/jobs?from=2026-10-01&to=2026-10-07&status=active&status=possibly_closed&status=closed");
    expect(screen.getByTestId("kpi-passed-count")).toHaveTextContent("4/6 · 67% new jobs passed the filter");
    expect(screen.getByTestId("kpi-new")).toHaveTextContent("+50% vs the previous 7 days");
    expect(screen.getByTestId("kpi-rank-value")).toHaveTextContent("66.5");
    expect(screen.getByTestId("kpi-applied-value")).toHaveAttribute("href", "/pipeline");
    // pass rate 4/6 against 3/4 before: -8.3 points, said with an arrow, a sign and the unit
    expect(within(screen.getByTestId("kpi-passed")).getByRole("img", { name: /8\.3/ })).toBeInTheDocument();
  });

  it("gives the pass rate, the mean rank and the applied count a ratio bar each", () => {
    render7();
    expect(within(screen.getByTestId("kpi-passed")).getByRole("meter", { name: "Share of the new jobs that passed the filter" })).toHaveAttribute("aria-valuenow", "66.7");
    expect(within(screen.getByTestId("kpi-rank")).getByRole("meter", { name: /red line is the push line/ })).toBeInTheDocument();
    expect(within(screen.getByTestId("kpi-applied")).getByRole("meter", { name: "Applied, as a share of the jobs that passed" })).toBeInTheDocument();
  });

  it("says so instead of drawing a line when fewer than two days have data", () => {
    const data = filledData();
    // only one day of the range has any jobs
    data.daily = data.daily.slice(1);
    render7(data);
    expect(within(screen.getByTestId("kpi-new")).getByTestId("trend-insufficient")).toHaveTextContent("Not enough data: 2 days needed");
    // on the yellow card the words are ink on the highlight (the quiet grey was 2:1 on it in the terminal theme)
    expect(within(screen.getByTestId("kpi-new")).getByTestId("trend-insufficient")).toHaveClass("text-hi-ink");
  });

  it("shows no change glyph (only the words) when there is no previous window to compare with, and no % in the title", () => {
    const data = filledData();
    data.previousTotal = 0;
    data.previousPassed = 0;
    render7(data);
    const tile = screen.getByTestId("kpi-new");
    expect(tile).toHaveTextContent("No jobs in the previous 7 days");
    expect(tile.querySelector(".jr-delta")).toBeNull();
    expect(screen.getByTestId("kpi-passed").querySelector(".jr-delta")).toBeNull();
    expect(within(screen.getByTestId("kpi-passed")).getByRole("heading", { level: 2 })).toHaveTextContent(/^Passed the filter$/);
  });

  it("draws one column per day, each segment a link to that day", () => {
    render7();
    const chart = screen.getByTestId("daily-chart");
    expect(within(chart).getAllByRole("listitem")).toHaveLength(7);
    expect(within(chart).getByRole("link", { name: "2026-10-06: Passed the filter 3" })).toHaveAttribute("href", "/jobs?from=2026-10-06&to=2026-10-06&status=active&status=possibly_closed&status=closed");
    expect(within(chart).getByRole("link", { name: "2026-10-06: Filtered out 2" })).toHaveAttribute("href", "/jobs?from=2026-10-06&to=2026-10-06&filteredOnly=true&status=active&status=possibly_closed&status=closed");
    // a day without jobs has text for screen readers but no link
    expect(chart).toHaveTextContent("0 passed, 0 filtered out");
    expect(within(chart).getAllByRole("link")).toHaveLength(3);
  });

  it("lists sources with labels, filter pass share and links; an unknown family is shown as is", () => {
    render7();
    const list = screen.getByTestId("sources-list");
    const ats = within(list).getByText("Company ATS").closest("li") as HTMLElement;
    expect(within(ats).getByRole("link", { name: "4" })).toHaveAttribute("href", "/jobs?from=2026-10-01&to=2026-10-07&source=ats&filtered=true&status=active&status=possibly_closed&status=closed");
    expect(within(ats).getByRole("link", { name: "75% passed" })).toHaveAttribute("href", "/jobs?from=2026-10-01&to=2026-10-07&source=ats&status=active&status=possibly_closed&status=closed");
    expect(within(list).getByText("newfamily")).toBeInTheDocument();
  });

  it("lists cities: the listed ones and remote link to /jobs, other does not", () => {
    render7();
    const list = screen.getByTestId("cities-list");
    expect(within(list).getByRole("link", { name: "2" })).toHaveAttribute("href", "/jobs?from=2026-10-01&to=2026-10-07&city=Berlin&status=active&status=possibly_closed&status=closed");
    const remote = within(list).getByText("Remote").closest("li") as HTMLElement;
    expect(within(remote).getByRole("link")).toHaveAttribute("href", "/jobs?from=2026-10-01&to=2026-10-07&workplace=remote&status=active&status=possibly_closed&status=closed");
    expect(within(within(list).getByText("Other").closest("li") as HTMLElement).queryByRole("link")).toBeNull();
  });

  it("shows the salary disclosure as a ring, with the median and the annual bands", () => {
    render7();
    const ring = screen.getByTestId("card-disclosure");
    expect(within(ring).getByTestId("salary-rate")).toHaveTextContent("50%");
    expect(within(ring).getByRole("meter")).toHaveAttribute("aria-valuenow", "50");
    expect(ring).toHaveTextContent("2/4 · 50% jobs");
    expect(ring).toHaveTextContent("Median · last 7 days · 2 jobs: €70k");
    expect(within(ring).getByRole("link", { name: "Open these jobs" })).toHaveAttribute("href", "/jobs?from=2026-10-01&to=2026-10-07&salary=true&status=active&status=possibly_closed&status=closed");
    const card = screen.getByTestId("card-salary");
    expect(within(screen.getByTestId("salary-chart")).getAllByRole("listitem")).toHaveLength(2);
    expect(card).toHaveTextContent("60–70k a year (base currency): 1 job");
    // the median and the floor are named in the legend, the amount written like the text card does (one format)
    expect(card).toHaveTextContent("median · last 7 days · 2 jobs · €70k");
    expect(within(card).getByTestId("salary-chart")).toHaveTextContent("median €70k");
  });

  it("shows the four-step conversion and the pass-rate waffle from the same numbers", () => {
    render7();
    const funnel = screen.getByTestId("card-conversion");
    expect(within(funnel).getByRole("group")).toHaveAccessibleName(/Fetched 6, Passed 4, ≥ 70 1, Applied 1/);
    const waffle = within(screen.getByTestId("card-pass-rate")).getByRole("meter");
    expect(waffle).toHaveAttribute("aria-valuenow", "66.7");
    expect(screen.getByTestId("pass-rate-detail")).toHaveTextContent("4/6 · 67% new jobs");
  });

  it("shows the categories with their name and mean rank, and the high-value link naming them", () => {
    render7();
    const list = screen.getByTestId("signals-list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    expect(list).toHaveTextContent("mean rank 82");
    expect(list).toHaveTextContent("T3Competitive");
    expect(screen.getByTestId("signals-highpay")).toHaveAttribute("href", "/jobs?from=2026-10-01&to=2026-10-07&high=true&status=active&status=possibly_closed&status=closed");
    expect(screen.getByText(/High-value signals \(Explicit amount \/ Equity\)/)).toBeInTheDocument();
  });

  it("shows the rank distribution with the jobs still waiting for a score", () => {
    render7();
    expect(screen.getByTestId("scores-mean")).toHaveTextContent("Mean 66.5");
    expect(screen.getByTestId("scores-pending")).toHaveTextContent("1 waiting for AI scoring");
    expect(within(screen.getByTestId("scores-chart")).getAllByRole("listitem")).toHaveLength(21);
  });

  it("shows the funnel with conversion and the exits", () => {
    render7();
    const funnel = screen.getByTestId("funnel-list");
    expect(within(funnel).getAllByRole("listitem").map((li) => li.getAttribute("data-row"))).toEqual(["new", "interested", "preparing", "applied", "interviewing", "offer"]);
    expect(within(funnel).getByText("Applied").closest("li")).toHaveTextContent("100% of the stage before");
    // "interested" says its share of the new jobs too
    expect(within(funnel).getByText("Interested").closest("li")).toHaveTextContent(/\d+% of the stage before/);
    expect(screen.getByTestId("funnel-exits")).toHaveTextContent("Rejected 1");
    expect(within(funnel).getByRole("link", { name: "2" })).toHaveAttribute("href", "/pipeline");
  });

  it("names the filter reasons and falls back to the raw code", () => {
    render7();
    const list = screen.getByTestId("filters-list");
    expect(within(list).getByText("Location not on your list")).toBeInTheDocument();
    expect(within(list).getByText("old_code")).toBeInTheDocument();
    expect(screen.getByTestId("card-filters")).toHaveTextContent("2 jobs it removed");
  });

  it("gives a card without data its own empty text", () => {
    const data = filledData();
    data.filters = { total: 0, reasons: [] };
    data.scores = { atPushLine: 0, scored: 0, pending: 2, avgRank: null, buckets: [] };
    render7(data);
    expect(within(screen.getByTestId("card-filters")).getByTestId("card-empty")).toHaveTextContent("No jobs were filtered out");
    expect(within(screen.getByTestId("card-scores")).getByTestId("card-empty")).toHaveTextContent("No scored jobs");
  });

  it("renders in Chinese", () => {
    render7(filledData(), "zh");
    expect(screen.getByTestId("card-daily")).toHaveTextContent("每日新增岗位");
    expect(screen.getByTestId("kpi-new")).toHaveTextContent("比前 7 天 +50%");
    expect(within(screen.getByTestId("range-switch")).getAllByRole("radio")[0]).toHaveTextContent("7 天");
  });
});

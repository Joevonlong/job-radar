import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { CompPanel, type CompPanelProps, type CompSignal } from "@/components/jobs/detail/comp-panel";
import { JdPanel } from "@/components/jobs/detail/jd-panel";
import { JobBadges } from "@/components/jobs/job-badges";
import type { JobListItem } from "@/components/jobs/types";
import { highlightQuotes } from "@/lib/dashboard/jd";
import { signalAmountText } from "@/lib/dashboard/signal-label";
import { hasActiveFilters, jobsListHref, loadJobsSearchParams, withLegacyKeys } from "@/lib/jobs/search-params";
import { bonusPolicy, signalBonus } from "@/lib/signals/bonus";
import { buildCatalog, toCategoryView, toCategoryViews } from "@/lib/signals/catalog";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";
import { shippedInterests } from "./helpers";

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
    {node}
  </NextIntlClientProvider>
);

const amount = (over: Record<string, unknown> = {}) => ({
  currency: "EUR",
  min: 85000,
  max: 105000,
  eurPerYear: { min: 85000, max: 105000 },
  stated: { min: 85000, max: 105000, period: "year" },
  periodAssumed: false,
  currencyAssumed: false,
  ...over,
});

const sig = (id: number, tier: CompSignal["tier"], over: Partial<CompSignal> = {}): CompSignal => ({
  id,
  tier,
  kind: tier === "T1" ? "salary_range" : "equity",
  value: tier === "T1" ? amount() : null,
  quote: `quote ${id}`,
  extractor: "rule",
  ...over,
});

const interests = shippedInterests();
const catalog = buildCatalog(interests);
const categories = toCategoryViews(catalog, "en");

/** A row signal of the default categories, as `toListItems` makes it. */
function rowSignal(tier: string, kind: string, value: unknown, over: Partial<JobListItem["signals"][number]> = {}): JobListItem["signals"][number] {
  const category = catalog.byId.get(tier);
  if (!category) throw new Error(`no category ${tier}`);
  const view = toCategoryView(category, "en");
  return { tier, kind, value, category: { kind: view.kind, label: view.label, icon: view.icon, color: view.color, code: view.code }, ...over };
}

function panelProps(signals: CompSignal[], over: Partial<CompPanelProps> = {}): CompPanelProps {
  return {
    salary: null,
    salaryDisclosed: false,
    signals,
    categories,
    bonus: { ...signalBonus(signals.map((s) => s.tier), interests), cap: interests.bonus_cap },
    scan: { aiReviewed: true },
    language: "en",
    ...over,
  };
}

const item = (signals: JobListItem["signals"]): JobListItem => ({
  id: 1,
  title: "t",
  companyName: "c",
  locations: [],
  workplace: "unknown",
  contract: "unknown",
  isAgency: false,
  germanLevelRequired: "unknown",
  jobStatus: "active",
  salaryDisclosed: false,
  salaryText: null,
  families: [],
  applicationStatus: null,
  rank: null,
  signals,
  timeLabel: "",
  timeTitle: "",
  posted: { day: "10/27", ago: "4 d", title: "", known: true },
});

describe("signal badges on a row", () => {
  it("show 💰 amount, 📈, 🏅, 🎁 once per tier, in tier order, without benefit tags", () => {
    const { container } = render(
      wrap(
        <JobBadges
          job={item([
            rowSignal("T1", "salary_range", amount()),
            rowSignal("T2", "equity", null),
            rowSignal("T3", "competitive_pay", null),
            rowSignal("T3", "competitive_pay", null),
            rowSignal("T4", "bonus", null),
            rowSignal("tag", "JobRad", null),
          ])}
        />,
      ),
    );
    const badges = [...container.querySelectorAll("[data-slot=signal-badge]")];
    expect(badges.map((b) => b.getAttribute("data-tier"))).toEqual(["T1", "T2", "T3", "T4"]);
    expect(badges[0]).toHaveTextContent("€85–105k");
    expect(badges[1]).toHaveTextContent("Equity");
    expect(badges[2]).toHaveTextContent("Competitive");
    expect(badges[3]).toHaveTextContent("Bonus");
    expect(screen.queryByText(/JobRad/)).toBeNull();
    expect(screen.queryByText(/Salary not disclosed/)).toBeNull();
  });
});

describe("a stated amount below the salary floor", () => {
  const rwsAmount = amount({ currency: "USD", min: 31200, max: 31200, eurPerYear: null, stated: { min: 15, max: 15, period: "hour" } });

  it("shows a muted badge without the money icon, and keeps the amount on the row", () => {
    const { container } = render(wrap(<JobBadges job={{ ...item([rowSignal("T1", "salary_fixed", rwsAmount, { belowFloor: true })]), amountMinAnnualEur: 70000, amountCurrency: "EUR" }} />));
    const badge = container.querySelector("[data-slot=signal-badge]");
    expect(badge).toHaveAttribute("data-tier", "T1");
    expect(badge).toHaveAttribute("data-muted", "true");
    expect(badge).toHaveTextContent("$31.2k");
    expect(badge?.textContent).not.toContain("💰");
    expect(badge?.className).not.toContain("signal-t1");
    expect(badge).toHaveAttribute("title", expect.stringContaining("€70,000"));
    expect(screen.queryByText(/Salary not disclosed/)).toBeNull();
  });

  it("shows the green badge for a qualifying amount, and prefers it when a job has both", () => {
    const { container } = render(
      wrap(
        <JobBadges
          job={item([rowSignal("T1", "salary_fixed", rwsAmount, { belowFloor: true }), rowSignal("T1", "salary_range", amount(), { belowFloor: false })])}
        />,
      ),
    );
    const badges = container.querySelectorAll("[data-slot=signal-badge]");
    expect(badges).toHaveLength(1);
    expect(badges[0]).not.toHaveAttribute("data-muted");
    expect(badges[0]).toHaveTextContent("💰");
  });

  it("explains on the detail page: no points, no bonus, and the reason", () => {
    const signals = [sig(1, "T1", { value: rwsAmount, belowFloor: true, quote: "Rate: 15 USD/Hour" })];
    const policy = bonusPolicy(interests, 70000, "EUR");
    render(wrap(<CompPanel {...panelProps(signals, { bonus: { ...signalBonus(signals, interests, policy), cap: interests.bonus_cap } })} />));
    expect(screen.getByTestId("signal-points")).toHaveTextContent("No points: below the €70k per year a high-pay signal needs");
    expect(screen.getByTestId("signal-value")).toHaveTextContent("≈ $31k /yr"); // hourly rate x hours: converted, whole k
    expect(screen.getByTestId("signal-item").querySelector("[data-slot=signal-badge]")).toHaveAttribute("data-muted", "true");
    expect(screen.getByTestId("bonus-line")).toHaveTextContent("No bonus points");
    expect(screen.getByTestId("below-floor-note")).toHaveTextContent("brings no “Explicit amount” points");
  });
});

describe("a stated amount that is possibly another region's pay", () => {
  const usd = amount({ currency: "USD", min: 160000, max: 200000, eurPerYear: { min: 137600, max: 172000 }, stated: { min: 160000, max: 200000, period: "year" }, otherRegion: "currency" });

  it("shows a muted badge with the note on the row", () => {
    const { container } = render(wrap(<JobBadges job={{ ...item([rowSignal("T1", "salary_range", usd, { otherRegion: true })]), salaryText: "€138–172k" }} />));
    const badge = container.querySelector("[data-slot=signal-badge]");
    expect(badge).toHaveAttribute("data-muted", "true");
    expect(badge).toHaveTextContent("€138–172k · other region?");
    expect(badge).toHaveAttribute("title", expect.stringContaining("possibly another region's pay"));
  });

  it("explains on the detail page: the EUR figure, the reason, and no T1 points", () => {
    const signals = [sig(1, "T1", { value: usd, otherRegion: "currency", quote: "$160K - $200K" })];
    const policy = bonusPolicy(interests, 70000, "EUR");
    render(
      wrap(
        <CompPanel
          {...panelProps(signals, {
            bonus: { ...signalBonus(signals, interests, policy), cap: interests.bonus_cap },
            salary: { normalized: "USD 160,000–200,000 / year (≈ EUR 137,600–172,000 / year)", raw: "$160K - $200K", periodAssumed: false, otherRegion: { reason: "currency", currency: "USD" } },
          })}
        />,
      ),
    );
    expect(screen.getByTestId("salary-other-region")).toHaveTextContent("stated in USD");
    expect(screen.getByTestId("signal-points")).toHaveTextContent("No points: possibly another region's pay");
    expect(screen.getByTestId("signal-other-region")).toHaveTextContent("stated in USD");
    expect(screen.getByTestId("signal-item").querySelector("[data-slot=signal-badge]")).toHaveAttribute("data-muted", "true");
    expect(screen.getByTestId("other-region-note")).toHaveTextContent("brings no “Explicit amount” points");
  });
});

describe("CompPanel", () => {
  it("lists each signal with tier, normalized value, points and its verbatim quote", () => {
    render(wrap(<CompPanel {...panelProps([sig(1, "T1", { quote: "Salary: €85,000–105,000 per year" }), sig(2, "T2", { quote: "We offer equity" })])} />));
    const items = screen.getAllByTestId("signal-item");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByTestId("signal-value")).toHaveTextContent("€85–105k /yr");
    expect(within(items[0]!).getByTestId("signal-points")).toHaveTextContent("+10 pts");
    expect(within(items[0]!).getByTestId("signal-quote")).toHaveTextContent("“Salary: €85,000–105,000 per year”");
    expect(within(items[1]!).getByTestId("signal-points")).toHaveTextContent("+8 pts");
    // the JD states an amount: no "not disclosed" box
    expect(screen.queryByTestId("salary-unknown")).toBeNull();
  });

  it("counts a tier once and shows the capped total", () => {
    render(wrap(<CompPanel {...panelProps([sig(1, "T1"), sig(2, "T2"), sig(3, "T3"), sig(4, "T3", { quote: "second T3" })])} />));
    const points = screen.getAllByTestId("signal-points").map((p) => p.textContent);
    expect(points).toEqual(["+10 pts", "+8 pts", "+3 pts", "counted once per category"]);
    expect(screen.getByTestId("bonus-line")).toHaveTextContent("Bonus 21 → capped at 15");
  });

  it("shows a monthly salary as the yearly figure and says what the JD stated", () => {
    const monthly = amount({ min: 86400, max: 86400, eurPerYear: { min: 86400, max: 86400 }, stated: { min: 7200, max: 7200, period: "month" } });
    render(wrap(<CompPanel {...panelProps([sig(1, "T1", { value: monthly, quote: "EUR 7,200 monthly" })])} />));
    expect(screen.getByTestId("signal-value")).toHaveTextContent("≈ €86k /yr");
    expect(screen.getByText("JD states €7.2k /mo")).toBeInTheDocument();
  });

  it("notes an assumed currency and period instead of hiding the assumption", () => {
    render(wrap(<CompPanel {...panelProps([sig(1, "T1", { value: amount({ min: null, max: 120000, currencyAssumed: true, periodAssumed: true }) })])} />));
    expect(screen.getByText("The JD names no currency; read as EUR")).toBeInTheDocument();
    expect(screen.getByText("The JD names no period; read as annual")).toBeInTheDocument();
    expect(screen.getByTestId("signal-value")).toHaveTextContent("up to €120k /yr");
  });

  it("separates benefit tags (no points) from pay signals", () => {
    render(wrap(<CompPanel {...panelProps([sig(1, "T3"), sig(2, "tag", { kind: "JobRad", quote: "JobRad für alle" })])} />));
    expect(screen.getAllByTestId("signal-item")).toHaveLength(1);
    expect(within(screen.getByTestId("benefit-tags")).getByText("JobRad")).toBeInTheDocument();
    expect(screen.getByText("Other benefits (no bonus points)")).toBeInTheDocument();
  });

  it("says nothing was found (not 'pending') after a scan, and pending before the first one", () => {
    const { rerender } = render(wrap(<CompPanel {...panelProps([], { scan: { aiReviewed: false } })} />));
    expect(screen.getByTestId("signals-none")).toBeInTheDocument();
    expect(screen.getByTestId("signal-scan-state")).toHaveTextContent("AI review of this JD is still pending");
    rerender(wrap(<CompPanel {...panelProps([], { scan: null })} />));
    expect(screen.getByTestId("signals-pending")).toBeInTheDocument();
  });

  it("says a T1 quote comes from the source's salary field, not from the JD", () => {
    const { rerender } = render(wrap(<CompPanel {...panelProps([sig(1, "T1", { quote: "€75,000.00/yr - €100,000.00/yr", quoteSource: "structured" })])} />));
    expect(screen.getByTestId("signal-quote")).toHaveTextContent("€75,000.00/yr - €100,000.00/yr");
    expect(screen.getByText("Source field: the posting's own salary field, not JD text")).toBeInTheDocument();
    expect(screen.queryByText("Found by rules")).not.toBeInTheDocument();
    rerender(wrap(<CompPanel {...panelProps([sig(1, "T1", { quoteSource: "structured" })])} />, "zh"));
    expect(screen.getByText("来源字段：岗位自带的薪资字段原文，不是 JD 正文")).toBeInTheDocument();
  });

  it("is available in Chinese with the same keys", () => {
    render(wrap(<CompPanel {...panelProps([sig(1, "T1", { extractor: "ai" })])} />, "zh"));
    expect(screen.getByTestId("signal-points")).toHaveTextContent("加分 +10");
    expect(screen.getByText("来源：AI")).toBeInTheDocument();
  });
});

describe("JD highlight of signal quotes", () => {
  it("highlights a quote that contains Markdown the panel does not show", () => {
    const segments = highlightQuotes("Wir bieten ein attraktives Gehalt und mehr.", ["Wir bieten ein **attraktives** Gehalt"]);
    expect(segments.find((s) => s.quote === 0)?.text).toBe("Wir bieten ein attraktives Gehalt");
  });

  it("marks the quoted sentence with its tier and lists the tiers in the legend", () => {
    const jd = "Intro.\n\nSalary: €85,000–105,000 per year.\n\nWe offer equity.";
    const { container } = render(
      wrap(
        <JdPanel
          description={jd}
          language="en"
          translation={null}
          translationLanguage="中文"
          categories={categories}
          quotes={[
            { text: "Salary: €85,000–105,000 per year.", tier: "T1" },
            { text: "We offer equity.", tier: "T2" },
          ]}
        />,
      ),
    );
    const marks = [...container.querySelectorAll("[data-testid=jd-body] mark")];
    expect(marks.map((m) => `${m.getAttribute("data-tier")}:${m.getAttribute("title")}:${m.textContent}`)).toEqual(["T1:Explicit amount:Salary: €85,000–105,000 per year.", "T2:Equity:We offer equity."]);
    expect(within(screen.getByTestId("jd-legend")).getAllByText(/^T[12]$/)).toHaveLength(2);
  });
});

describe("amount text", () => {
  it("reads the lenient legacy shape of the dev seed", () => {
    expect(signalAmountText({ max: 120000, currency: "EUR" }, "en")).toMatchObject({ normalized: "up to €120k /yr", stated: null });
    expect(signalAmountText({ amount: 86400, currency: "EUR", period: "year" }, "en")?.normalized).toBe("€86.4k /yr");
    expect(signalAmountText({ nonsense: true }, "en")).toBeNull();
  });
});

describe("high-value quick filter state", () => {
  it("is a boolean URL parameter that counts as an active filter", async () => {
    const on = await loadJobsSearchParams({ high: "true" });
    expect(on.high).toBe(true);
    expect(hasActiveFilters(on)).toBe(true);
    expect(hasActiveFilters(await loadJobsSearchParams({}))).toBe(false);
  });

  it("reads the old `t12` key as `high` and never writes it back", async () => {
    const old = withLegacyKeys(await loadJobsSearchParams({ t12: "true" }));
    expect(old.high).toBe(true);
    expect(old.t12).toBeNull();
    expect(hasActiveFilters(old)).toBe(true);
    expect(jobsListHref(old)).toBe("/jobs?high=true");
    // an explicit `high` wins over the old key
    expect(withLegacyKeys(await loadJobsSearchParams({ t12: "true", high: "false" })).high).toBe(false);
  });
});

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CapBar } from "@/components/jobs/detail/cap-bar";
import { ChecksPanel } from "@/components/jobs/detail/checks-panel";
import { CompPanel, type CompSignal } from "@/components/jobs/detail/comp-panel";
import { JdPanel } from "@/components/jobs/detail/jd-panel";
import { requestJdJump } from "@/components/jobs/detail/marks";
import { SalaryCard } from "@/components/jobs/detail/salary-card";
import { floorCheck } from "@/lib/dashboard/floor-check";
import { germanCheck } from "@/lib/dashboard/german-check";
import type { JobSalary } from "@/lib/domain/types";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";
import { defaultCategoryViews } from "../signals/helpers";
import { asSalary } from "../helpers/salary";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
    {node}
  </NextIntlClientProvider>
);

const AXIS = { minK: 40, maxK: 200, tickStepK: 20, currency: "EUR" };

describe("CapBar", () => {
  it("draws the tiers that count and what goes over the cap, and says what counts", () => {
    render(
      wrap(
        <CapBar
          tiers={[
            { id: "T1", points: 10, color: "amber", code: "T1", label: "Explicit amount" },
            { id: "T2", points: 8, color: "teal", code: "T2", label: "Equity" },
            { id: "T4", points: 2, color: "blue", code: "T4", label: "Bonus" },
          ]}
          cap={15}
        />,
      ),
    );
    const bar = screen.getByTestId("cap-bar");
    expect(bar).toHaveAttribute("data-total", "20");
    expect(bar).toHaveAttribute("data-counted", "15");
    expect(bar).toHaveTextContent("Bonus 20 → capped at 15");
    expect(screen.getByTestId("cap-bar-bonus")).toHaveTextContent("+15");
    expect(within(bar).getByRole("img")).toHaveAttribute("aria-label", expect.stringContaining("15 counts in the rank value"));
  });
});

describe("jump tags of the pay signals", () => {
  const signal = (id: number, over: Partial<CompSignal>): CompSignal => ({ id, tier: "T2", kind: "equity", value: null, quote: "Stock options for all.", extractor: "rule", ...over });
  const bonus = { categories: [{ id: "T2", points: 8 }], sum: 8, bonus: 8, cap: 15, capped: false };
  const props = { salary: null, salaryDisclosed: false, categories: defaultCategoryViews(), bonus, scan: { aiReviewed: true }, language: "en" as const };

  it("makes the tag of a quote the JD shows a button, and leaves one without text plain", () => {
    render(wrap(<CompPanel {...props} signals={[signal(1, { quoteIndex: 0, inJd: true }), signal(2, { tier: "T4", kind: "bonus", quote: "Yearly bonus.", quoteIndex: 1, inJd: false })]} />));
    const [withJump, without] = screen.getAllByTestId("signal-item");
    expect(within(withJump as HTMLElement).getByTestId("jump-tag")).toHaveAttribute("data-quote-index", "0");
    expect(within(without as HTMLElement).queryByTestId("jump-tag")).toBeNull();
    // the quote itself (C7) is shown either way
    expect(within(without as HTMLElement).getByTestId("signal-quote")).toHaveTextContent("Yearly bonus.");
  });

  it("sends the jump request with the quote index", async () => {
    const seen: number[] = [];
    const listener = (event: Event) => seen.push((event as CustomEvent<{ index: number }>).detail.index);
    window.addEventListener("jr:jd-jump", listener);
    render(wrap(<CompPanel {...props} signals={[signal(1, { quoteIndex: 3, inJd: true })]} />));
    await userEvent.setup().click(screen.getByTestId("jump-tag"));
    window.removeEventListener("jr:jd-jump", listener);
    expect(seen).toEqual([3]);
  });

  it("jumps from a benefit tag too, only when the JD has its sentence", () => {
    const tag = (id: number, over: Partial<CompSignal>) => signal(id, { tier: "tag", kind: "30 days", quote: "30 days of vacation", ...over });
    render(wrap(<CompPanel {...props} signals={[tag(1, { quoteIndex: 0, inJd: true }), tag(2, { kind: "JobRad", quote: "JobRad", quoteIndex: 1, inJd: false })]} />));
    const chips = within(screen.getByTestId("benefit-tags")).getAllByRole("listitem");
    expect(within(chips[0] as HTMLElement).getByTestId("jump-tag")).toBeInTheDocument();
    expect(within(chips[1] as HTMLElement).queryByTestId("jump-tag")).toBeNull();
  });
});

describe("JdPanel jump", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  const jd = "Intro.\n\nWhat we offer:\n- Stock options for all.\n- Yearly bonus.";
  const quotes = [
    { text: "Stock options for all.", tier: "T2" as const },
    { text: "Yearly bonus.", tier: "T4" as const },
  ];

  it("gives every quote found in the JD a mark with a stable id", () => {
    render(wrap(<JdPanel translationLanguage="Chinese" description={jd} language="en" categories={defaultCategoryViews()} quotes={quotes} translation={<div />} />));
    expect(document.getElementById("jd-quote-0")).toHaveTextContent("Stock options for all.");
    expect(document.getElementById("jd-quote-1")).toHaveTextContent("Yearly bonus.");
  });

  it("scrolls the mark to the middle and flashes it when asked", () => {
    render(wrap(<JdPanel translationLanguage="Chinese" description={jd} language="en" categories={defaultCategoryViews()} quotes={quotes} translation={<div />} />));
    act(() => requestJdJump(1));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: "center" }));
    expect(document.getElementById("jd-quote-1")).toHaveClass("jr-flash");
    expect(document.getElementById("jd-quote-0")).not.toHaveClass("jr-flash");
  });

  it("a breakdown quote gets a dotted underline without a fill, and the legend names it", () => {
    const mixed = [...quotes, { text: "Intro.", tier: "breakdown" as const }];
    render(wrap(<JdPanel translationLanguage="Chinese" description={jd} language="en" categories={defaultCategoryViews()} quotes={mixed} translation={<div />} />));
    const mark = document.getElementById("jd-quote-2");
    expect(mark).toHaveTextContent("Intro.");
    expect(mark).toHaveAttribute("data-tier", "breakdown");
    expect(mark?.className).toContain("decoration-dotted");
    expect(mark?.className).not.toContain("bg-signal");
    expect(screen.getByTestId("jd-legend-breakdown")).toHaveTextContent("Breakdown quote");
    // a signal mark keeps its tier colour
    expect(document.getElementById("jd-quote-0")?.className).toContain("bg-signal-t2");
  });

  it("the legend has no breakdown entry without breakdown quotes", () => {
    render(wrap(<JdPanel translationLanguage="Chinese" description={jd} language="en" categories={defaultCategoryViews()} quotes={quotes} translation={<div />} />));
    expect(screen.queryByTestId("jd-legend-breakdown")).toBeNull();
  });

  it("goes back to the original tab first when the translation tab is open", async () => {
    const user = userEvent.setup();
    render(wrap(<JdPanel translationLanguage="Chinese" description={jd} language="en" categories={defaultCategoryViews()} quotes={quotes} translation={<div>translated</div>} />));
    await user.click(screen.getByRole("tab", { name: "Chinese translation" }));
    act(() => requestJdJump(0));
    expect(screen.getByRole("tab", { name: /^Original/ })).toHaveAttribute("aria-selected", "true");
    expect(document.getElementById("jd-quote-0")).toHaveClass("jr-flash");
  });
});

describe("ChecksPanel", () => {
  const salary = (max: number): JobSalary =>
    asSalary({
    raw: "x",
    currency: "EUR",
    period: "year",
    min: null,
    max,
    perYear: { min: null, max },
    eurPerYear: { min: null, max },
    periodAssumed: false,
    origin: "description",
    qualityStatus: "valid",
    reasonCodes: [],
  });
  const base = { germanPenalty: null, skills: [], profileHasSkills: true, floor: floorCheck(null, 70000, "EUR") };

  it("says German is not required and draws only your level", () => {
    render(wrap(<ChecksPanel languageName="German" {...base} german={germanCheck("none", "B1")} />));
    expect(screen.getByTestId("german-check")).toHaveTextContent("The job does not require German");
    const scale = screen.getByRole("img", { name: /Language level: you B1/ });
    expect(scale).not.toHaveAccessibleName(/required/i);
  });

  it("does not guess when the posting is silent", () => {
    render(wrap(<ChecksPanel languageName="German" {...base} german={germanCheck("unknown", "B1")} />));
    expect(screen.getByTestId("german-check")).toHaveAttribute("data-state", "unknown");
    expect(screen.getByTestId("german-check")).toHaveTextContent("does not state a German requirement");
  });

  it("shows the gap and the points it cost", () => {
    render(wrap(<ChecksPanel languageName="German" {...base} german={germanCheck("C1", "B1")} germanPenalty={20} />));
    expect(screen.getByTestId("german-check")).toHaveTextContent("2 level(s) short: C1 required, you have B1 · −20 match points");
    expect(screen.getByRole("img", { name: /needs C1/ })).toBeInTheDocument();
  });

  it("marks the skills you have and the ones you miss, and the floor verdict", () => {
    render(
      wrap(
        <ChecksPanel languageName="German"
          {...base}
          german={germanCheck("none", null)}
          skills={[
            { name: "Python", have: true },
            { name: "AWS", have: false },
          ]}
          floor={floorCheck(salary(58000), 70000, "EUR")}
        />,
      ),
    );
    const skills = within(screen.getByTestId("skills")).getAllByRole("listitem");
    expect(skills.map((li) => li.firstElementChild?.getAttribute("data-have"))).toEqual(["true", "false"]);
    expect(screen.getByRole("img", { name: /1\/2/ })).toBeInTheDocument();
    expect(screen.getByTestId("floor-check")).toHaveAttribute("data-state", "fail");
    expect(screen.getByTestId("floor-check")).toHaveTextContent("€58k < €70k");
  });

  it("does not turn an empty profile into 0/N", () => {
    render(wrap(<ChecksPanel languageName="German" {...base} german={germanCheck("none", null)} skills={[{ name: "Python", have: false }]} profileHasSkills={false} />));
    expect(screen.getByTestId("skills-no-profile")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /0\/1/ })).toBeNull();
  });
});

describe("SalaryCard", () => {
  const stated: JobSalary = asSalary({
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
  });;
  const props = { salaryDisclosed: true, normalizedText: "EUR 85,000–105,000 / year", axis: AXIS, floor: 70000, sample: { count: 12, min: 5 } };

  it("draws the stated range with the floor and the median, and the percentile", () => {
    render(wrap(<SalaryCard {...props} salary={stated} median={96000} percentile={72} />));
    expect(screen.getByTestId("salary-card-figure")).toHaveTextContent("€85–105k");
    expect(screen.getByTestId("salary-card-figure")).toHaveAttribute("data-salary-state", "stated");
    expect(screen.getByRole("img", { name: /floor 70k.*median 96k/ })).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: /72%/ })).toBeInTheDocument();
  });

  it("names the dashed line with its scope and sample, the way /me and /insights do", () => {
    render(wrap(<SalaryCard {...props} salary={stated} median={85700} percentile={72} sample={{ count: 8, min: 5 }} />));
    expect(screen.getByTestId("salary-median")).toHaveTextContent("Median · this month · 8 jobs: €85.7k");
  });

  it("has no median line without a median", () => {
    render(wrap(<SalaryCard {...props} salary={stated} median={null} percentile={null} sample={{ count: 2, min: 5 }} />));
    expect(screen.queryByTestId("salary-median")).toBeNull();
  });

  it("says why there is no percentile instead of drawing one", () => {
    render(wrap(<SalaryCard {...props} salary={stated} median={null} percentile={null} sample={{ count: 2, min: 5 }} />));
    expect(screen.getByTestId("salary-no-sample")).toHaveTextContent("Only 2 jobs");
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("shows 'not disclosed', never 0, when there is no salary", () => {
    render(wrap(<SalaryCard {...props} salaryDisclosed={false} salary={null} normalizedText={null} median={null} percentile={null} />));
    expect(screen.getByTestId("salary-card-undisclosed")).toHaveTextContent("Salary not disclosed");
    expect(screen.getByRole("img", { name: /not disclosed/i })).toBeInTheDocument();
    expect(screen.queryByTestId("salary-no-sample")).toBeNull();
  });
});

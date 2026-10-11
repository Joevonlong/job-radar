import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ChecksPanel } from "@/components/jobs/detail/checks-panel";
import { SalaryCard } from "@/components/jobs/detail/salary-card";
import { JobRow, type JobListViz } from "@/components/jobs/job-row";
import type { JobListItem } from "@/components/jobs/types";
import { boardSalaryOf } from "@/components/pipeline/salary";
import { SalaryChip } from "@/components/pipeline/salary-chip";
import { annualSalaryLabel, describeSalary, isApproxAnnual, listSalary } from "@/lib/dashboard/salary";
import { floorCheck } from "@/lib/dashboard/floor-check";
import { germanCheck } from "@/lib/dashboard/german-check";
import type { JobSalary } from "@/lib/domain/types";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";
import { asSalary } from "../helpers/salary";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
    {node}
  </NextIntlClientProvider>
);

const base: JobSalary = asSalary({
  raw: "x",
  currency: "EUR",
  period: "year",
  min: null,
  max: null,
  perYear: null,
  eurPerYear: null,
  periodAssumed: false,
  origin: "text",
  qualityStatus: "valid",
  reasonCodes: [],
});
/** EUR 7,200 a month: the annual figure is a conversion. */
const monthly: JobSalary = { ...base, period: "month", min: 7200, max: 7200, perYear: { min: 86400, max: 86400 }, basePerYear: { min: 86400, max: 86400 }, baseCurrency: "EUR", eurPerYear: { min: 86400, max: 86400 } };
const usd: JobSalary = { ...base, currency: "USD", min: 100000, max: 120000, perYear: { min: 100000, max: 120000 }, basePerYear: { min: 92000, max: 110400 }, baseCurrency: "EUR", eurPerYear: { min: 92000, max: 110400 } };
const yearly: JobSalary = { ...base, min: 85000, max: 105000, perYear: { min: 85000, max: 105000 }, basePerYear: { min: 85000, max: 105000 }, baseCurrency: "EUR", eurPerYear: { min: 85000, max: 105000 } };

const viz: JobListViz = { pushLine: 70, bonusCap: 15, floor: 70000, salaryAxis: { minK: 40, maxK: 200, tickStepK: 20, currency: "EUR" }, freshness: { decayHours: 72, warnHours: 24 }, nowIso: "2026-10-08T12:00:00.000Z", timezone: "Europe/Berlin" };
const AXIS = viz.salaryAxis;

function listItem(salary: JobSalary): JobListItem {
  const row = listSalary(salary, "en", "EUR");
  return {
    id: 1,
    title: "Machine Learning Engineer",
    companyName: "Tidewater",
    locations: [],
    workplace: "onsite",
    contract: "permanent",
    isAgency: false,
    germanLevelRequired: "unknown",
    jobStatus: "active",
    salaryDisclosed: true,
    salaryText: annualSalaryLabel(salary, "en"),
    salaryMin: row?.min ?? null,
    salaryMax: row?.max ?? null,
    salaryApprox: row?.approx ?? false,
    families: [],
    applicationStatus: null,
    rank: { rankValue: null, score: null, signalBonus: 0, filterResult: "passed", filterReasons: [], stale: false },
    signals: [],
    timeLabel: "",
    timeTitle: "",
  };
}

describe("a converted salary reads the same everywhere ", () => {
  it("decides 'converted' in one place: a period other than a year, or a non-EUR currency on the EUR basis", () => {
    expect(isApproxAnnual(yearly, "base")).toBe(false);
    expect(isApproxAnnual(monthly, "base")).toBe(true);
    expect(isApproxAnnual(monthly, "own")).toBe(true);
    expect(isApproxAnnual(usd, "base")).toBe(true);
    expect(isApproxAnnual(usd, "own")).toBe(false);
  });

  it("writes '≈ €86k' in the list row, the board card, the detail card, the ticker / badge label and the floor check", () => {
    // list row (mini axis headline)
    const { unmount } = render(wrap(<JobRow job={listItem(monthly)} favorite={false} seen index={0} active stagger={false} viz={viz} onFocusRow={() => undefined} onAction={() => undefined} />));
    const rowCell = document.querySelector(".jr-salm__f");
    expect(rowCell?.textContent).toBe("≈ €86k");
    unmount();

    // ticker / badges: the label
    expect(annualSalaryLabel(monthly, "en")).toBe("≈ €86k");

    // board chip
    const board = boardSalaryOf(monthly);
    expect(board).toMatchObject({ approx: true });
    const chip = render(wrap(<SalaryChip salary={board} floor={70000} />));
    expect(chip.container.textContent).toBe("≈ €86k");
    chip.unmount();

    // detail card
    render(wrap(<SalaryCard salary={monthly} salaryDisclosed normalizedText={null} axis={AXIS} floor={70000} median={null} percentile={null} sample={{ count: 1, min: 5 }} />));
    expect(screen.getByTestId("salary-card-figure")).toHaveTextContent("≈ €86k");
    expect(screen.getByTestId("salary-card-figure")).not.toHaveTextContent("86.4");
  });

  it("agrees with the description of the pay panel and the floor check", () => {
    expect(describeSalary(monthly, "en").normalized).toBe("≈ €86k /yr");
    const check = floorCheck(monthly, 70000, "EUR");
    expect(check.approx).toBe(true);
    render(wrap(<ChecksPanel german={germanCheck("none", "B1")} germanPenalty={null} skills={[]} profileHasSkills floor={check} />));
    expect(screen.getByTestId("floor-check")).toHaveTextContent("≈ €86k ≥ €70k");
  });

  it("leaves a stated yearly EUR range exactly as it is", () => {
    expect(annualSalaryLabel(yearly, "en")).toBe("€85–105k");
    expect(boardSalaryOf(yearly)?.approx).toBe(false);
    expect(floorCheck(yearly, 70000, "EUR").approx).toBe(false);
  });

  it("marks a USD range converted with the EUR rate", () => {
    expect(annualSalaryLabel(usd, "en")).toBe("≈ €92–110k");
    expect(listSalary(usd, "en", "EUR")).toMatchObject({ approx: true, figure: "$100–120k" });
  });
});

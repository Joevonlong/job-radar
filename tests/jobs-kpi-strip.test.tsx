import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import { KpiStrip } from "@/components/jobs/kpi-strip";
import { buildKpiBlocks, type CycleKpiCounts } from "@/lib/dashboard/kpi";
import en from "../messages/en.json";

const cycle = (cycleId: number, over: Partial<CycleKpiCounts> = {}): CycleKpiCounts => ({ cycleId, fetched: 100, passed: 40, qualified: 10, salaryStated: 8, pushed: 3, ...over });

const strip = (cycles: CycleKpiCounts[]) =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <KpiStrip blocks={buildKpiBlocks(cycles, 7)} cycleLabel="Evening 17:38" sourceCount={14} pushLine={70} />
    </NextIntlClientProvider>,
  );

describe("KpiStrip", () => {
  it("with a single cycle prints no dashed change tag and no lone-dot sparkline, only '1 cycle'", () => {
    const { container } = strip([cycle(1)]);
    expect(container.querySelector(".jr-delta")).toBeNull();
    expect(container.querySelector(".jr-spark")).toBeNull();
    for (const key of ["fetched", "passed", "qualified", "salary", "pushed"]) expect(screen.getByTestId(`kpi-${key}-trend-none`)).toHaveTextContent("1 cycle");
  });

  it("with a previous cycle shows the change and the trend line", () => {
    const { container } = strip([cycle(1, { passed: 30 }), cycle(2)]);
    expect(container.querySelectorAll(".jr-delta").length).toBe(5);
    expect(container.querySelectorAll(".jr-spark").length).toBe(5);
    expect(screen.queryByTestId("kpi-passed-trend-none")).toBeNull();
  });

  it("a change that is unknown for one block (no push line) shows nothing for that block", () => {
    const { container } = strip([cycle(1, { qualified: null }), cycle(2, { qualified: null })]);
    expect(container.querySelector('[data-testid="kpi-qualified"] .jr-delta')).toBeNull();
    expect(container.querySelector('[data-testid="kpi-passed"] .jr-delta')).not.toBeNull();
  });

  it("a block whose step failed says so in words and what waits, never a 0", () => {
    const { container } = strip([cycle(1), cycle(2, { fetched: 987, passed: 0, unprocessed: 231, unprocessedBlocks: { passed: "unprocessed" } })]);
    const passed = screen.getByTestId("kpi-passed");
    expect(passed).toHaveAttribute("data-pending", "unprocessed");
    expect(passed).not.toHaveAttribute("data-value");
    expect(screen.getByTestId("kpi-pending-word")).toHaveTextContent("Pending");
    expect(screen.getByTestId("kpi-pending-note")).toHaveTextContent("231 of 987 waiting");
    expect(container.querySelector('[data-testid="kpi-passed"] .jr-delta')).toBeNull();
    // the fetched block is a real number
    expect(screen.getByTestId("kpi-fetched")).toHaveAttribute("data-value", "987");
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { useState, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { FloorPreview } from "@/components/profile/floor-preview";
import { isBelowFloor, previewFloor, shownSalary, type StatedSalary } from "@/lib/profile/floor-preview";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const wrap = (node: ReactNode, locale: "en" | "zh" = "zh") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
    {node}
  </NextIntlClientProvider>
);

const salaries: StatedSalary[] = [
  { min: 50_000, max: 60_000 },
  { min: null, max: 58_000 },
  { min: 60_000, max: 80_000 },
  { min: 90_000, max: null }, // only a lower bound: the filter never drops it
  { min: 80_000, max: 100_000 },
  { min: 100_000, max: 140_000 },
];
const axis = { minK: 40, maxK: 200, tickStepK: 20, currency: "EUR" };

describe("previewFloor", () => {
  it("counts the jobs whose stated upper bound is below the floor (the filter's rule)", () => {
    expect(previewFloor(salaries, 0)).toEqual({ total: 6, filtered: 0, percent: 0 });
    expect(previewFloor(salaries, 60_001)).toMatchObject({ filtered: 2, percent: 33 });
    expect(previewFloor(salaries, 60_000)).toMatchObject({ filtered: 1 }); // equal is not below
    expect(previewFloor(salaries, 90_000)).toMatchObject({ filtered: 3 });
    expect(previewFloor(salaries, 1_000_000)).toMatchObject({ filtered: 5, percent: 83 }); // the min-only job survives any floor
  });

  it("has no percentage without disclosed jobs (not 0 %)", () => {
    expect(previewFloor([], 70_000)).toEqual({ total: 0, filtered: 0, percent: null });
  });

  it("shows a job as its upper bound, else its lower bound", () => {
    expect(shownSalary({ min: 90_000, max: null })).toBe(90_000);
    expect(shownSalary({ min: 80_000, max: 100_000 })).toBe(100_000);
    expect(isBelowFloor({ min: 90_000, max: null }, 200_000)).toBe(false);
  });
});

function Harness({ start = "70000", onFloor }: { start?: string; onFloor?: (text: string) => void }) {
  const [floor, setFloor] = useState(start);
  return (
    <FloorPreview
      salaries={salaries}
      axis={axis}
      median={{ value: 95_000, count: 8, minSample: 5 }}
      floorText={floor}
      inputId="floor"
      onFloorChange={(text) => {
        setFloor(text);
        onFloor?.(text);
      }}
    />
  );
}

describe("FloorPreview", () => {
  it("moves the floor line and the count live as the slider is dragged, and writes nothing itself", () => {
    const seen: string[] = [];
    render(wrap(<Harness onFloor={(text) => seen.push(text)} />));
    const drop = screen.getByTestId("floor-drop");
    expect(drop).toHaveAttribute("data-filtered", "2");
    expect(drop).toHaveTextContent("会过滤掉 2 / 6 个本月写明薪资的岗位（33%）");
    expect(screen.getByTestId("floor-value")).toHaveTextContent("€70k");

    fireEvent.change(screen.getByRole("slider", { name: "拖动试试" }), { target: { value: "110000" } });
    expect(drop).toHaveAttribute("data-filtered", "4");
    expect(screen.getByTestId("floor-value")).toHaveTextContent("€110k");
    expect(screen.getByTestId("floor-strip").querySelectorAll("i")).toHaveLength(6);
    expect(screen.getByTestId("floor-strip").querySelectorAll('[data-dropped="true"]')).toHaveLength(4);
    // only the draft text moved: the callback is the whole interface (Save writes elsewhere)
    expect(seen).toEqual(["110000"]);
    expect(screen.getByRole("img", { name: /本月已披露薪资/ })).toBeInTheDocument();
  });

  it("says what the yellow block is, and that it runs past the axis", () => {
    render(wrap(<FloorPreview salaries={[...salaries, { min: 200_000, max: 250_000 }]} axis={axis} median={{ value: 95_000, count: 8, minSample: 5 }} floorText="70000" inputId="floor" onFloorChange={() => {}} />));
    const axisEl = document.querySelector(".jr-sax") as HTMLElement;
    expect(axisEl.getAttribute("aria-label")).toMatch(/^本月写明的薪资范围 €58–250k，上限超出坐标轴/);
    expect(axisEl.getAttribute("aria-label")).not.toMatch(/^年薪/);
    expect(screen.getByTestId("floor-axis-legend")).toHaveTextContent("黄块 = 本月已披露薪资的范围 €58–250k，不是某一个岗位的薪资");
    expect(screen.getByTestId("floor-axis-legend")).toHaveTextContent("超出 200k 的部分没有画出");
  });

  it("says so instead of guessing when the floor is not a number or no job stated a salary", async () => {
    const user = userEvent.setup();
    const { rerender } = render(wrap(<Harness start="" />));
    expect(screen.getByTestId("floor-drop")).toHaveTextContent("填一个数字");
    expect(screen.getByTestId("floor-value")).toHaveTextContent("—");
    await user.click(screen.getByRole("slider", { name: "拖动试试" }));

    rerender(wrap(<FloorPreview salaries={[]} axis={axis} median={{ value: null, count: 0, minSample: 5 }} floorText="70000" inputId="floor" onFloorChange={() => {}} />));
    expect(screen.getByTestId("floor-drop")).toHaveTextContent("预览没有依据");
    expect(screen.queryByTestId("floor-strip")).toBeNull();
  });
});

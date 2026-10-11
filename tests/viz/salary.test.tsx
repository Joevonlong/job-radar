import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SalaryAxis } from "@/components/viz/salary-axis";
import { SalaryMini } from "@/components/viz/salary-mini";
import { axisPosition, axisTicks, freeGap, LABEL_CLASH_PCT, markerEdgeSide, markerLabelPlan, markerLabelRows, markerLabelSides, salaryAxisScale, salarySpan, salaryState } from "@/components/viz/salary-shared";
import { Percentile } from "@/components/viz/percentile";

import { AXIS, renderViz } from "./helpers";

vi.mock("@number-flow/react", () => import("./number-flow-mock").then((m) => m.numberFlowMock));

describe("salary axis geometry", () => {
  it("reads its scale from ui.yaml", () => {
    expect(salaryAxisScale({ salary_axis: { min_k: 40, max_k: 200, tick_step_k: 20 } }, "EUR")).toEqual(AXIS);
    expect(axisTicks(AXIS)).toEqual([40, 60, 80, 100, 120, 140, 160, 180, 200]);
    expect(axisTicks({ minK: 0, maxK: 100, tickStepK: 25 })).toEqual([0, 25, 50, 75, 100]);
  });

  it("positions amounts and clamps what is outside the axis", () => {
    expect(axisPosition(40_000, AXIS)).toBe(0);
    expect(axisPosition(120_000, AXIS)).toBe(50);
    expect(axisPosition(200_000, AXIS)).toBe(100);
    expect(axisPosition(10_000, AXIS)).toBe(0);
    expect(axisPosition(900_000, AXIS)).toBe(100);
  });

  it("spans: closed, open at one end, none", () => {
    expect(salarySpan(80_000, 120_000, AXIS)).toEqual({ left: 25, width: 25, open: null, clip: null });
    expect(salarySpan(120_000, null, AXIS)).toEqual({ left: 50, width: 50, open: "end", clip: null });
    expect(salarySpan(null, 120_000, AXIS)).toEqual({ left: 0, width: 50, open: "start", clip: null });
    expect(salarySpan(null, null, AXIS)).toBeNull();
  });

  it("reports which end of a range lies outside the axis (cut there, not silently)", () => {
    expect(salarySpan(70_000, 250_000, AXIS)).toMatchObject({ left: 18.75, width: 81.25, clip: "end" });
    expect(salarySpan(20_000, 120_000, AXIS)).toMatchObject({ left: 0, clip: "start" });
    expect(salarySpan(20_000, 250_000, AXIS)).toMatchObject({ left: 0, width: 100, clip: "both" });
    expect(salarySpan(190_000, 200_000, AXIS)?.clip).toBeNull(); // exactly on the end is inside
  });

  it("puts a label in the widest gap between the markers, never on one", () => {
    expect(freeGap([null, null])).toEqual({ center: 50, width: 100 });
    // a median at 30 %: the gap to its right (30..100) is the widest, the label goes to its middle
    expect(freeGap([null, 30])).toEqual({ center: 65, width: 70 });
    // a floor at 80 % and a median at 30 %: 0..30, 30..80, 80..100
    expect(freeGap([80, 30])).toEqual({ center: 55, width: 50 });
    expect(freeGap([90, null])).toEqual({ center: 45, width: 90 });
  });

  it("four states", () => {
    expect(salaryState({ min: 95_000, max: 120_000, floor: 70_000 })).toBe("stated");
    expect(salaryState({ min: 58_000, max: 66_000, floor: 70_000 })).toBe("below_floor");
    expect(salaryState({ min: 129_000, max: 156_000, floor: 70_000, otherRegion: true })).toBe("other_region");
    expect(salaryState({ min: null, max: null, floor: 70_000 })).toBe("none");
    // only a lower bound under the floor is not "below the floor": the top is open
    expect(salaryState({ min: 60_000, floor: 70_000 })).toBe("stated");
  });
});

describe("marker label rows", () => {
  it("keeps far-apart labels on one row", () => {
    expect(markerLabelRows([10, 60])).toEqual([0, 0]);
    expect(markerLabelRows([10, 10 + LABEL_CLASH_PCT])).toEqual([0, 0]); // exactly the clash distance: they just stop touching
  });

  it("moves the later marker up when two labels would overlap, in either order", () => {
    expect(markerLabelRows([50, 55])).toEqual([0, 1]);
    expect(markerLabelRows([55, 50])).toEqual([0, 1]);
    expect(markerLabelRows([50, 50])).toEqual([0, 1]);
  });

  it("handles an absent marker and three markers", () => {
    expect(markerLabelRows([null, 50])).toEqual([0, 0]);
    expect(markerLabelRows([50, null])).toEqual([0, 0]);
    expect(markerLabelRows([50, 55, 60])).toEqual([0, 1, 2]);
    expect(markerLabelRows([10, 15, 80])).toEqual([0, 1, 0]);
  });
});

describe("marker label sides (no line crosses a label)", () => {
  it("puts the lower-row label on the far side of its line from the neighbour that moved up", () => {
    // floor 80k (row 0), median 85.7k (row 1) on the 40-200k axis: the median's taller line is to the right, so the floor label ends at its line
    const floor = axisPosition(80_000, AXIS);
    const median = axisPosition(85_700, AXIS);
    const rows = markerLabelRows([floor, median]);
    expect(rows).toEqual([0, 1]);
    expect(markerLabelSides([floor, median], rows)).toEqual(["left", null]);
    // median to the left of the floor: the floor label starts at its line, away from the median's line
    const right = axisPosition(90_000, AXIS);
    expect(markerLabelSides([right, median], markerLabelRows([right, median]))).toEqual(["right", null]);
  });

  it("leaves labels alone when nothing clashes or a marker is absent", () => {
    expect(markerLabelSides([10, 60], [0, 0])).toEqual([null, null]);
    expect(markerLabelSides([null, 50], [0, 0])).toEqual([null, null]);
    expect(markerLabelSides([50, null], [0, 0])).toEqual([null, null]);
  });
});

describe("marker label plan", () => {
  it("keeps a floor label that would have to turn left from running out of the box: the median takes the first row, the floor goes up", () => {
    // floor 70k = 19 % of the axis, median 85.7k: the floor label cannot end at its line (about 60 px of room needed)
    const plan = markerLabelPlan(axisPosition(70_000, AXIS), axisPosition(85_700, AXIS));
    expect(plan).toEqual({ floorRow: 1, medianRow: 0, floorSide: null, medianSide: "right" });
  });

  it("is the usual plan when the floor has room on its left, or nothing clashes", () => {
    expect(markerLabelPlan(axisPosition(110_000, AXIS), axisPosition(120_000, AXIS))).toMatchObject({ floorRow: 0, medianRow: 1, floorSide: "left" });
    expect(markerLabelPlan(axisPosition(70_000, AXIS), axisPosition(120_000, AXIS))).toEqual({ floorRow: 0, medianRow: 0, floorSide: null, medianSide: null });
    expect(markerLabelPlan(null, axisPosition(85_700, AXIS))).toEqual({ floorRow: 0, medianRow: 0, floorSide: null, medianSide: null });
  });
});

describe("marker labels near the ends of the axis", () => {
  it("turns a median label left past the middle and a floor label inward near either end", () => {
    expect(markerEdgeSide("median", axisPosition(100_000, AXIS))).toBeNull();
    expect(markerEdgeSide("median", axisPosition(180_700, AXIS))).toBe("left");
    expect(markerEdgeSide("floor", axisPosition(100_000, AXIS))).toBeNull();
    expect(markerEdgeSide("floor", axisPosition(195_000, AXIS))).toBe("left");
    expect(markerEdgeSide("floor", axisPosition(42_000, AXIS))).toBe("right");
  });

  it("puts a median near the right end on the left of its line, and wins over a clash side", () => {
    const end = renderViz(<SalaryAxis min={85_000} max={105_000} axis={AXIS} floor={70_000} median={180_700} />).container;
    expect(end.querySelector(".jr-sax__m")).toHaveAttribute("data-side", "left");
    // floor and median both near the right end and close: the median stays inward, the floor takes the clash side
    const both = renderViz(<SalaryAxis min={85_000} max={105_000} axis={AXIS} floor={185_000} median={190_000} />).container;
    expect(both.querySelector(".jr-sax__m")).toHaveAttribute("data-side", "left");
    expect(both.querySelector(".jr-sax__f")).toHaveAttribute("data-side", "left");
  });
});

describe("SalaryAxis", () => {
  it("anchors the floor label away from the median's line when the two are close", () => {
    const close = renderViz(<SalaryAxis min={85_000} max={105_000} axis={AXIS} floor={110_000} median={118_000} />).container;
    expect(close.querySelector(".jr-sax__f")).toHaveAttribute("data-side", "left");
    expect(close.querySelector(".jr-sax__m")).not.toHaveAttribute("data-side");
    const swapped = renderViz(<SalaryAxis min={85_000} max={105_000} axis={AXIS} floor={118_000} median={110_000} />).container;
    expect(swapped.querySelector(".jr-sax__f")).toHaveAttribute("data-side", "right");
    // floor near the start of the axis: its label cannot end at its line (it would leave the box), so it goes up a row and the median keeps the first
    const nearStart = renderViz(<SalaryAxis min={85_000} max={105_000} axis={AXIS} floor={70_000} median={85_700} />).container;
    expect(nearStart.querySelector(".jr-sax__f")).toHaveAttribute("data-label-row", "1");
    expect(nearStart.querySelector(".jr-sax__f")).not.toHaveAttribute("data-side");
    expect(nearStart.querySelector(".jr-sax__m")).toHaveAttribute("data-label-row", "0");
    const far = renderViz(<SalaryAxis min={85_000} max={105_000} axis={AXIS} floor={80_000} median={120_000} />).container;
    expect(far.querySelector(".jr-sax__f")).not.toHaveAttribute("data-side");
    expect(far.querySelector(".jr-sax__m")).not.toHaveAttribute("data-side");
  });

  it("puts the median label on a second row when the floor is close, and keeps one row when it is far", () => {
    const close = renderViz(<SalaryAxis min={80_000} max={120_000} axis={AXIS} floor={110_000} median={90_000} />).container;
    expect(close.querySelector(".jr-sax")).toHaveAttribute("data-label-rows", "2");
    expect(close.querySelector(".jr-sax__f")).toHaveAttribute("data-label-row", "0");
    expect(close.querySelector(".jr-sax__m")).toHaveAttribute("data-label-row", "1");
    const far = renderViz(<SalaryAxis min={80_000} max={190_000} axis={AXIS} floor={50_000} median={150_000} />).container;
    expect(far.querySelector(".jr-sax")).toHaveAttribute("data-label-rows", "1");
    expect(far.querySelector(".jr-sax__m")).toHaveAttribute("data-label-row", "0");
    const floorOnly = renderViz(<SalaryAxis min={80_000} max={120_000} axis={AXIS} floor={110_000} />).container;
    expect(floorOnly.querySelector(".jr-sax")).toHaveAttribute("data-label-rows", "1");
  });

  it("marks a range that runs past the axis, says so in its name, and takes a name of its own", () => {
    const clipped = renderViz(<SalaryAxis min={70_000} max={250_000} axis={AXIS} floor={70_000} median={81_700} ariaLabel="本月已披露薪资的范围 €70–250k" />).container;
    expect(clipped.querySelector(".jr-sax__r")).toHaveAttribute("data-clip", "end");
    expect(clipped.querySelector(".jr-sax")).toHaveAttribute("aria-label", "本月已披露薪资的范围 €70–250k，上限超出坐标轴（200k 以上的部分没画），底线 70k，中位数 81.7k");
    expect(clipped.querySelector(".jr-sax")?.getAttribute("aria-label")).not.toMatch(/^年薪/);
    const inside = renderViz(<SalaryAxis min={95_000} max={120_000} axis={AXIS} />).container;
    expect(inside.querySelector(".jr-sax__r")).not.toHaveAttribute("data-clip");
  });

  it("puts the not-disclosed label beside the median line, not on it", () => {
    const { container } = renderViz(<SalaryAxis axis={AXIS} floor={null} median={85_700} />);
    const label = container.querySelector(".jr-sax__none") as HTMLElement;
    // median at 28.6 %: the widest gap is to its right
    expect(parseFloat(label.style.left)).toBeGreaterThan(60);
    // one line always (a second one would run down onto the tick numbers); the full explanation is its tooltip
    expect(label).toHaveAttribute("data-tip");
    const bare = renderViz(<SalaryAxis axis={AXIS} />).container.querySelector(".jr-sax__none") as HTMLElement;
    expect(bare.style.left).toBe("50%");
  });

  it("stated range, floor and median", () => {
    const { container } = renderViz(<SalaryAxis min={95_000} max={120_000} axis={AXIS} floor={70_000} median={96_000} />);
    const axis = container.querySelector(".jr-sax") as HTMLElement;
    expect(axis).toHaveAttribute("data-salary-state", "stated");
    expect(axis).toHaveAttribute("aria-label", "年薪 €95–120k，底线 70k，中位数 96k");
    const range = container.querySelector(".jr-sax__r") as HTMLElement;
    expect(range.style.left).toBe("34.38%");
    expect(range).toHaveAttribute("data-tip", "€95–120k");
    expect(container.querySelector(".jr-sax__f")).toHaveAttribute("data-l", "底线 70k");
    expect(container.querySelector(".jr-sax__m")).toHaveAttribute("data-l", "中位 96k");
    expect(Array.from(container.querySelectorAll(".jr-sax__l")).map((e) => e.textContent)).toEqual(["40", "60", "80", "100", "120", "140", "160", "180", "200"]);
  });

  it("below the floor: grey block", () => {
    const { container } = renderViz(<SalaryAxis min={58_000} max={66_000} axis={AXIS} floor={70_000} />);
    expect(container.querySelector(".jr-sax--muted")).not.toBeNull();
  });

  it("another region: hatched block, converted figure with ≈ and the posting's own wording in the tip", () => {
    const { container } = renderViz(<SalaryAxis min={129_000} max={156_000} axis={AXIS} otherRegion figure="$140–170k" />);
    expect(container.querySelector(".jr-sax--other")).not.toBeNull();
    expect(container.querySelector(".jr-sax__r")).toHaveAttribute("data-tip", "$140–170k（≈ €129–156k）");
  });

  it("not disclosed: dashed frame and words, no block (never drawn as 0)", () => {
    const { container } = renderViz(<SalaryAxis axis={AXIS} floor={70_000} median={96_000} />);
    expect(container.querySelector(".jr-sax--none")).not.toBeNull();
    expect(container.querySelector(".jr-sax__r")).toBeNull();
    expect(screen.getByText("未披露 · 按规则保留")).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "年薪未披露");
  });

  it("an open range runs to the end of the axis and says which end", () => {
    const { container } = renderViz(<SalaryAxis min={90_000} axis={AXIS} />);
    expect(container.querySelector(".jr-sax__r")).toHaveAttribute("data-open", "end");
  });

  it("amounts outside the axis sit on its end", () => {
    const { container } = renderViz(<SalaryAxis min={190_000} max={260_000} axis={AXIS} />);
    const range = container.querySelector(".jr-sax__r") as HTMLElement;
    expect(range.style.left).toBe("93.75%");
    expect(range.style.width).toBe("6.25%");
  });

  it("follows the configured scale", () => {
    const { container } = renderViz(<SalaryAxis min={50_000} max={60_000} axis={{ minK: 0, maxK: 100, tickStepK: 50, currency: "EUR" }} />);
    expect(Array.from(container.querySelectorAll(".jr-sax__l")).map((e) => e.textContent)).toEqual(["0", "50", "100"]);
    expect((container.querySelector(".jr-sax__r") as HTMLElement).style.left).toBe("50%");
  });
});

describe("SalaryMini", () => {
  it("figure, axis and the percentile line", () => {
    const { container } = renderViz(<SalaryMini min={95_000} max={120_000} axis={AXIS} floor={70_000} percentile={72} />);
    expect(screen.getByText("€95–120k")).toBeInTheDocument();
    expect(screen.getByText("高于 72% 已披露岗位")).toBeInTheDocument();
    expect(container.querySelector(".jr-salm")).toHaveAttribute("data-tip", "€95–120k · 红线是你的底线 €70k");
    expect((container.querySelector(".jr-salm__t > u") as HTMLElement).style.left).toBe("18.75%");
  });

  it("below the floor", () => {
    renderViz(<SalaryMini min={58_000} max={66_000} axis={AXIS} floor={70_000} />);
    expect(screen.getByText("低于底线 · 不加分")).toBeInTheDocument();
  });

  it("other region keeps the posting's wording and explains the conversion", () => {
    renderViz(<SalaryMini min={129_000} max={156_000} axis={AXIS} otherRegion figure="$140–170k" />);
    expect(screen.getByText("$140–170k")).toBeInTheDocument();
    expect(screen.getByText("≈ €129–156k · 可能是其他地区的薪资")).toBeInTheDocument();
  });

  it("not disclosed says 未披露, not €0", () => {
    const { container } = renderViz(<SalaryMini axis={AXIS} floor={70_000} />);
    expect(screen.getByText("未披露")).toBeInTheDocument();
    expect(screen.getByText("没写薪资")).toBeInTheDocument();
    expect(container.textContent).not.toContain("€0");
    expect(container.querySelector(".jr-salm--none")).not.toBeNull();
  });

  it("one-sided figures", () => {
    renderViz(<SalaryMini max={120_000} axis={AXIS} />);
    expect(screen.getByText("最高 €120k")).toBeInTheDocument();
  });
});

describe("Percentile", () => {
  it.each([
    [72, "高于 72% 已披露岗位"],
    [0, "高于 0% 已披露岗位"],
    [100, "高于 100% 已披露岗位"],
  ])("%s", (value, text) => {
    renderViz(<Percentile value={value} />);
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", String(value));
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("null: no meter, 未披露", () => {
    renderViz(<Percentile value={null} />);
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByText("未披露")).toBeInTheDocument();
  });

  it("out of range is clamped", () => {
    renderViz(<Percentile value={140} />);
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "100");
  });
});

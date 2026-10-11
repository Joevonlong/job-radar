import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Battery } from "@/components/viz/battery";
import { Fraction, PercentBar, PercentText } from "@/components/viz/percent";
import { Ring } from "@/components/viz/ring";
import { SegBlocks } from "@/components/viz/seg-blocks";
import { Stacked100 } from "@/components/viz/stacked-100";
import { Waffle } from "@/components/viz/waffle";

import { renderViz } from "./helpers";

vi.mock("@number-flow/react", () => import("./number-flow-mock").then((m) => m.numberFlowMock));

describe("PercentText", () => {
  it.each([
    [24, "24", "%"],
    [2.64, "2.6", "%"],
    [3, "3.0", "%"],
    [0.04, "<0.1", "%"],
    [0, "0", "%"],
    [100, "100", "%"],
    [null, "—", ""],
  ])("%s", (value, text, unit) => {
    const { container } = renderViz(<PercentText value={value} />);
    expect(container.textContent).toBe(`${text}${unit}`);
  });

  it("the unit is the small part", () => {
    const { container } = renderViz(<PercentText value={24} size="xl" />);
    expect(container.querySelector("small")?.textContent).toBe("%");
    expect(container.querySelector(".jr-ptext--xl")).not.toBeNull();
  });
});

describe("PercentBar", () => {
  it("46: a meter with the percentage next to it", () => {
    const { container } = renderViz(<PercentBar value={46} />);
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "46");
    expect(meter).toHaveAttribute("aria-valuetext", "46%");
    expect(screen.getByText("46%")).toBeInTheDocument();
    expect((container.querySelector(".jr-pbar-track > i") as HTMLElement).style.width).toBe("46%");
  });

  it("0 and 100", () => {
    const zero = renderViz(<PercentBar value={0} />);
    expect(zero.getByRole("meter")).toHaveAttribute("aria-valuenow", "0");
    expect((zero.container.querySelector(".jr-pbar-track > i") as HTMLElement).style.width).toBe("0%");
    zero.unmount();
    const full = renderViz(<PercentBar value={100} />);
    expect((full.container.querySelector(".jr-pbar-track > i") as HTMLElement).style.width).toBe("100%");
  });

  it("null is a dashed empty bar with —, not 0%", () => {
    const { container } = renderViz(<PercentBar value={null} />);
    expect(screen.queryByRole("meter")).toBeNull();
    expect(container.textContent).toBe("—");
    expect(container.textContent).not.toContain("0%");
  });

  it("out of range fills the bar and still prints the real number", () => {
    renderViz(<PercentBar value={140} />);
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByText("140%")).toBeInTheDocument();
  });

  it("custom label, threshold line and sizes", () => {
    const { container } = renderViz(<PercentBar value={29.5} size="sm" label="29.5% / 抓取" threshold={80} />);
    expect(screen.getByText("29.5% / 抓取")).toBeInTheDocument();
    expect(container.querySelector(".jr-ratio--sm")).not.toBeNull();
    expect((container.querySelector(".jr-pbar-tick") as HTMLElement).style.left).toBe("80%");
  });
});

describe("Fraction", () => {
  it("62/135 · 46% with a bar", () => {
    const { container } = renderViz(<Fraction part={62} whole={135} unit="条" />);
    expect(container.querySelector("[data-fraction]")).toHaveAttribute("data-fraction", "62/135 · 46%");
    expect(screen.getByText("/ 135 条 · 46%")).toBeInTheDocument();
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuetext", "46%");
  });

  it("0 of 135 is 0%, 0 of 0 has no share", () => {
    const zero = renderViz(<Fraction part={0} whole={135} />);
    expect(zero.getByRole("meter")).toHaveAttribute("aria-valuenow", "0");
    zero.unmount();
    const empty = renderViz(<Fraction part={0} whole={0} />);
    expect(empty.queryByRole("meter")).toBeNull();
  });

  it("unknown part is —", () => {
    const { container } = renderViz(<Fraction part={null} whole={135} />);
    expect(container.querySelector("[data-fraction]")).toHaveAttribute("data-fraction", "—");
  });

  it("over 100% is shown as it is", () => {
    renderViz(<Fraction part={150} whole={100} bar={false} />);
    expect(screen.getByText("/ 100 · 150%")).toBeInTheDocument();
  });
});

describe("SegBlocks", () => {
  it.each([
    [0, 0],
    [40, 4],
    [80, 8],
    [100, 10],
    [160, 10],
  ])("%s -> %s cells", (value, lit) => {
    const { container } = renderViz(<SegBlocks value={value} />);
    expect(container.querySelectorAll(".jr-cells > i")).toHaveLength(10);
    expect(container.querySelectorAll(".jr-cells > i.jr-on")).toHaveLength(lit);
  });

  it("null: unknown cells, no meter", () => {
    const { container } = renderViz(<SegBlocks value={null} />);
    expect(screen.queryByRole("meter")).toBeNull();
    expect(container.querySelectorAll(".jr-unk")).toHaveLength(10);
    expect(container.textContent).toBe("—");
  });

  it("a meter with the percentage text next to it", () => {
    renderViz(<SegBlocks value={40} />);
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByText("40%")).toBeInTheDocument();
  });
});

describe("Waffle", () => {
  it.each([
    [0, 0],
    [41, 41],
    [41.6, 42],
    [100, 100],
  ])("%s -> %s lit of 100", (value, lit) => {
    const { container } = renderViz(<Waffle value={value} />);
    expect(container.querySelectorAll(".jr-waf > i")).toHaveLength(100);
    expect(container.querySelectorAll(".jr-waf > i.jr-on")).toHaveLength(lit);
  });

  it("null: dashed cells and —", () => {
    const { container } = renderViz(<Waffle value={null} />);
    expect(container.querySelectorAll(".jr-unk")).toHaveLength(100);
    expect(screen.queryByRole("meter")).toBeNull();
    expect(container.textContent).toContain("—");
  });

  it("writes the percentage next to the grid (and can leave it out)", () => {
    const { container } = renderViz(<Waffle value={41} />);
    expect(container.querySelector(".jr-ptext")?.textContent).toBe("41%");
    const without = renderViz(<Waffle value={41} showValue={false} />);
    expect(without.container.querySelector(".jr-ptext")).toBeNull();
  });

  it("small size", () => {
    const { container } = renderViz(<Waffle value={10} size="s" />);
    expect(container.querySelector(".jr-waf--s")).not.toBeNull();
  });
});

describe("Ring", () => {
  it("46%: dash offset leaves 54% of the circumference open", () => {
    const { container } = renderViz(<Ring value={46} caption="62/135" />);
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "46");
    const ring = container.querySelector(".jr-ring") as HTMLElement;
    const circ = Number(ring.style.getPropertyValue("--circ"));
    const off = Number(ring.style.getPropertyValue("--off"));
    expect(off / circ).toBeCloseTo(0.54, 2);
    expect(container.querySelector(".jr-ring > b")?.textContent).toBe("46%");
    expect(screen.getByText("62/135")).toBeInTheDocument();
  });

  it("shrinks the centre label with its length so it stays inside the inner hairline", () => {
    const scaleOf = (value: number) => {
      const { container, unmount } = renderViz(<Ring value={value} size="m" />);
      const scale = Number((container.querySelector(".jr-ring") as HTMLElement).style.getPropertyValue("--rl"));
      unmount();
      return scale;
    };
    expect(scaleOf(46)).toBeLessThanOrEqual(0.22); // "46%": the design's 22%
    expect(scaleOf(100)).toBeLessThan(scaleOf(46)); // "100%" is one glyph longer
    expect(scaleOf(8.9)).toBeLessThan(scaleOf(46)); // "8.9%" too
    // the label never needs more than the inner space (52% of the ring) at about 0.85 em per glyph
    for (const value of [0, 8.9, 46, 100]) expect(scaleOf(value) * 0.85 * (value === 8.9 || value === 100 ? 4 : value === 0 ? 2 : 3)).toBeLessThanOrEqual(0.52 + 0.005);
  });

  it("0 leaves the ring open, 100 closes it", () => {
    const zero = renderViz(<Ring value={0} />);
    expect(Number((zero.container.querySelector(".jr-ring") as HTMLElement).style.getPropertyValue("--off"))).toBeCloseTo(188.5, 0);
    zero.unmount();
    const full = renderViz(<Ring value={100} />);
    expect(Number((full.container.querySelector(".jr-ring") as HTMLElement).style.getPropertyValue("--off"))).toBe(0);
  });

  it("null: an empty ring with —, no meter", () => {
    const { container } = renderViz(<Ring value={null} />);
    expect(screen.queryByRole("meter")).toBeNull();
    expect(container.querySelector(".jr-ring > b")?.textContent).toBe("—");
  });

  it("out of range closes the ring but does not overshoot", () => {
    const { container } = renderViz(<Ring value={150} />);
    expect(Number((container.querySelector(".jr-ring") as HTMLElement).style.getPropertyValue("--off"))).toBe(0);
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "100");
  });

  it("three sizes", () => {
    const sizes = (["s", "m", "l"] as const).map((size) => {
      const { container, unmount } = renderViz(<Ring value={50} size={size} />);
      const px = (container.querySelector(".jr-ring") as HTMLElement).style.getPropertyValue("--rs");
      unmount();
      return px;
    });
    expect(sizes).toEqual(["48px", "84px", "110px"]);
  });
});

describe("Battery", () => {
  it("76 with the line at 80: 8 lit cells, green, the line does not trigger", () => {
    const { container } = renderViz(<Battery value={76} threshold={80} />);
    expect(container.querySelectorAll(".jr-bat__body > i")).toHaveLength(10);
    expect(container.querySelectorAll(".jr-bat__body > i.jr-on")).toHaveLength(8);
    expect(container.querySelector(".jr-bat")).toHaveAttribute("data-over", "false");
    expect((container.querySelector(".jr-bat__body") as HTMLElement).style.getPropertyValue("--c")).toBe("var(--good)");
    expect(screen.getByText("76%")).toBeInTheDocument();
    expect((container.querySelector(".jr-bat__th") as HTMLElement).style.getPropertyValue("--th")).toBe("80");
  });

  it("at and past the threshold the block turns red and says so", () => {
    const { container } = renderViz(<Battery value={92} threshold={80} />);
    expect(container.querySelector(".jr-bat")).toHaveAttribute("data-over", "true");
    expect((container.querySelector(".jr-bat__body") as HTMLElement).style.getPropertyValue("--c")).toBe("var(--bad)");
    expect(screen.getByRole("meter").getAttribute("aria-valuetext")).toContain("已过提醒线");
    expect(renderViz(<Battery value={80} threshold={80} />).container.querySelector(".jr-bat")).toHaveAttribute("data-over", "true");
  });

  it("0, 100, null and out of range", () => {
    expect(renderViz(<Battery value={0} threshold={80} />).container.querySelectorAll(".jr-bat__body > i.jr-on")).toHaveLength(0);
    expect(renderViz(<Battery value={100} threshold={80} />).container.querySelectorAll(".jr-bat__body > i.jr-on")).toHaveLength(10);
    expect(renderViz(<Battery value={250} threshold={80} />).container.querySelectorAll(".jr-bat__body > i.jr-on")).toHaveLength(10);
    const unknown = renderViz(<Battery value={null} threshold={80} />);
    expect(unknown.container.querySelectorAll(".jr-bat__body > i.jr-on")).toHaveLength(0);
    expect(unknown.container.querySelector(".jr-bat__v")?.textContent).toBe("—");
    expect(unknown.container.querySelector(".jr-bat")).toHaveAttribute("data-over", "false");
  });
});

describe("Stacked100", () => {
  const parts = [
    { key: "a", label: "感兴趣", value: 3, tone: "hi" as const },
    { key: "b", label: "准备中", value: 1, tone: "t4" as const },
    { key: "c", label: "已申请", value: 2, tone: "t3" as const },
    { key: "d", label: "面试中", value: 1, tone: "t2" as const },
  ];

  it("widths are shares of the sum, each segment says its percentage, the legend names the colours", () => {
    const { container } = renderViz(<Stacked100 parts={parts} />);
    const widths = Array.from(container.querySelectorAll<HTMLElement>(".jr-s100__bar > i")).map((i) => i.style.width);
    expect(widths).toEqual(["42.86%", "14.29%", "28.57%", "14.29%"]);
    expect(screen.getAllByText("43%")).toHaveLength(1);
    expect(container.querySelector(".jr-legend")?.textContent).toBe("感兴趣准备中已申请面试中");
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", expect.stringContaining("感兴趣 3 (43%)"));
  });

  it("parts of 0 are left out; a single part fills the bar", () => {
    const { container } = renderViz(<Stacked100 parts={[...parts.slice(0, 1), { key: "z", label: "零", value: 0, tone: "ink" }]} />);
    expect(container.querySelectorAll(".jr-s100__bar > i")).toHaveLength(1);
    expect((container.querySelector(".jr-s100__bar > i") as HTMLElement).style.width).toBe("100%");
  });

  it("all zero or empty: a dashed empty bar, not a full one", () => {
    const { container } = renderViz(<Stacked100 parts={[{ key: "z", label: "零", value: 0, tone: "ink" }]} />);
    expect(container.querySelector(".jr-s100__bar--empty")).not.toBeNull();
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "没有数据");
  });

  it("legend can be switched off", () => {
    expect(renderViz(<Stacked100 parts={parts} legend={false} />).container.querySelector(".jr-legend")).toBeNull();
  });
});

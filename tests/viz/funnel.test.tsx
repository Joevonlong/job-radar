import { describe, expect, it, vi } from "vitest";

import { Funnel } from "@/components/viz/funnel";

import { renderViz } from "./helpers";

vi.mock("@number-flow/react", () => import("./number-flow-mock").then((m) => m.numberFlowMock));

const bars = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>(".jr-fun__bar"));

describe("Funnel", () => {
  it("draws every stage relative to the first, the smallest non-zero one at least 4% wide", () => {
    const { container } = renderViz(
      <Funnel
        steps={[
          { key: "fetched", label: "抓取", value: 458 },
          { key: "passed", label: "通过", value: 229, tone: "t4" },
          { key: "pushed", label: "推送", value: 1, tone: "t2" },
        ]}
      />,
    );
    const [a, b, c] = bars(container);
    expect(a?.style.width).toBe("100%");
    expect(b?.style.width).toBe("50%");
    expect(c?.style.width).toBe("4%");
    expect(bars(container).every((bar) => bar.dataset.zero === undefined)).toBe(true);
  });

  it("a stage with 0 has no bar: only the empty outline track, never a coloured sliver", () => {
    const { container } = renderViz(
      <Funnel
        steps={[
          { key: "fetched", label: "抓取", value: 458 },
          { key: "scored", label: "≥70 分", value: 0, tone: "t2" },
          { key: "applied", label: "已申请", value: 0, tone: "hi" },
        ]}
      />,
    );
    const [, scored, applied] = bars(container);
    for (const bar of [scored, applied]) {
      expect(bar).toHaveAttribute("data-zero", "true");
      expect(bar).toHaveClass("jr-fun__bar--zero");
      expect(bar).not.toHaveClass("jr-grow");
      expect(bar?.style.width).toBe("");
    }
    // the number next to it still says 0
    expect(container.textContent).toContain("0");
  });

  it("when even the first stage is 0 no bar is drawn at all", () => {
    const { container } = renderViz(<Funnel steps={[{ key: "fetched", label: "抓取", value: 0 }, { key: "passed", label: "通过", value: 0 }]} />);
    expect(bars(container).every((bar) => bar.dataset.zero === "true")).toBe(true);
  });
});

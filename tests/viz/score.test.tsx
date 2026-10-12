import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ScoreComposition } from "@/components/viz/score-composition";
import { ScoreMeter } from "@/components/viz/score-meter";

import { renderViz } from "./helpers";

vi.mock("@number-flow/react", () => import("./number-flow-mock").then((m) => m.numberFlowMock));

const lit = (container: HTMLElement): number => container.querySelectorAll(".jr-segm > i.jr-on").length;
const cells = (container: HTMLElement): number => container.querySelectorAll(".jr-segm > i").length;

describe("ScoreMeter", () => {
  it("88: a meter with 20 cells, 18 lit, number with /100 and the band written next to it", () => {
    const { container } = renderViz(<ScoreMeter value={88} pushLine={70} match={78} bonus={10} />);
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuemin", "0");
    expect(meter).toHaveAttribute("aria-valuemax", "100");
    expect(meter).toHaveAttribute("aria-valuenow", "88");
    expect(meter).toHaveAttribute("aria-valuetext", "88/100，顶部匹配（匹配 78 + 加分 10）");
    expect(cells(container)).toBe(20);
    expect(lit(container)).toBe(18);
    expect(screen.getByText("/100")).toBeInTheDocument();
    expect(screen.getByText("顶部匹配 · 78+10")).toBeInTheDocument();
  });

  it("keeps '/100' and the '+6' of a value above 100 in one group next to the number", () => {
    const { container } = renderViz(<ScoreMeter value={106} pushLine={70} max={115} size="xl" />);
    const group = container.querySelector(".jr-score__x") as HTMLElement;
    expect(group).not.toBeNull();
    expect(Array.from(group.children).map((child) => child.textContent)).toEqual(["/100", "+6"]);
    // the group follows the number inside the number's own box, not the far corners of the card
    expect(container.querySelector(".jr-score__n")?.contains(group)).toBe(true);
  });

  it("puts the push-line triangle where the configured line is, not at a hard-coded 70", () => {
    const at = (line: number): string => {
      const { container, unmount } = renderViz(<ScoreMeter value={50} pushLine={line} />);
      const value = (container.querySelector(".jr-segm") as HTMLElement).style.getPropertyValue("--cut");
      unmount();
      return value;
    };
    expect(at(70)).toBe("70%");
    expect(at(60)).toBe("60%");
    expect(at(85)).toBe("85%");
  });

  it("without a push line (null) the triangle and the line in the tip are gone, the number stays", () => {
    const { container } = renderViz(<ScoreMeter value={45} pushLine={null} />);
    const meter = container.querySelector(".jr-segm") as HTMLElement;
    expect(meter).toHaveClass("jr-segm--noline");
    expect(meter.getAttribute("data-tip")).toBe("排序值 45");
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "45");
    expect(lit(container)).toBe(9);
  });

  it("0 is a score (all cells empty, band 偏弱), not 'unknown'", () => {
    const { container } = renderViz(<ScoreMeter value={0} pushLine={70} />);
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "0");
    expect(lit(container)).toBe(0);
    expect(screen.getByText("偏弱")).toBeInTheDocument();
  });

  it("100 fills every cell", () => {
    const { container } = renderViz(<ScoreMeter value={100} pushLine={70} />);
    expect(lit(container)).toBe(20);
  });

  it("null is — with 等待打分, no meter role and no lit cell", () => {
    const { container } = renderViz(<ScoreMeter value={null} pushLine={70} />);
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByRole("img", { name: /等待打分/ })).toBeInTheDocument();
    expect(screen.getByText("等待打分")).toBeInTheDocument();
    expect(container.querySelector(".jr-score__n")?.textContent).toBe("—");
    expect(lit(container)).toBe(0);
    expect(container.querySelector("[data-score=pending]")).not.toBeNull();
  });

  it("a rank above 100 shows its real number, fills every cell and marks the overflow (C3)", () => {
    const { container } = renderViz(<ScoreMeter value={106} pushLine={70} match={91} bonus={15} max={115} />);
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "106");
    expect(meter).toHaveAttribute("aria-valuemax", "115");
    expect(meter).toHaveAttribute("aria-valuetext", "106/100，顶部匹配（匹配 91 + 加分 15）");
    expect(container.querySelector(".jr-score__n")?.textContent).toContain("106");
    expect(lit(container)).toBe(20);
    expect(container.querySelectorAll(".jr-segm > i.jr-over")).toHaveLength(1);
    expect(container.querySelector(".jr-score__o")).toHaveAttribute("data-over", "6");
  });

  it("without a max prop the maximum is 100, and a value past it raises it instead of exceeding it", () => {
    const { container } = renderViz(<ScoreMeter value={130} pushLine={70} />);
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "130");
    expect(meter).toHaveAttribute("aria-valuemax", "130");
    expect(container.querySelector(".jr-score__n")?.textContent).toContain("130");
    expect(lit(container)).toBe(20);
    expect(container.querySelector(".jr-score__o")).toHaveAttribute("data-over", "30");
    const normal = renderViz(<ScoreMeter value={100} pushLine={70} />);
    expect(normal.container.querySelector(".jr-score__o")).toBeNull();
    expect(normal.container.querySelector(".jr-over")).toBeNull();
    expect(normal.getAllByRole("meter").at(-1)).toHaveAttribute("aria-valuemax", "100");
  });

  it("a negative value stays at 0", () => {
    const low = renderViz(<ScoreMeter value={-5} pushLine={70} />);
    expect(low.getByRole("meter")).toHaveAttribute("aria-valuenow", "0");
  });

  it("sm has 10 cells and no match/bonus split", () => {
    const { container } = renderViz(<ScoreMeter value={81} pushLine={70} size="sm" match={70} bonus={11} />);
    expect(cells(container)).toBe(10);
    expect(lit(container)).toBe(8);
    expect(screen.getByText("值得看")).toBeInTheDocument();
  });

  it("starts in the start state and plays when it has been seen (no IntersectionObserver: at once)", () => {
    const { container } = renderViz(<ScoreMeter value={50} pushLine={70} />);
    expect(container.querySelector(".jr-score")).toHaveAttribute("data-played", "true");
  });

  it("English band names", () => {
    renderViz(<ScoreMeter value={60} pushLine={70} />, "en");
    expect(screen.getByText("Average")).toBeInTheDocument();
  });
});

describe("ScoreComposition", () => {
  it("without a push line (null) the scale has no push line label", () => {
    const { container } = renderViz(<ScoreComposition match={45} bonus={0} bonusCap={15} pushLine={null} />);
    expect(container.querySelector(".jr-comp__lg [data-line]")).toBeNull();
    expect(container.querySelectorAll(".jr-comp__lg > span")).toHaveLength(3);
  });

  it("78 + 10 on the 0-115 scale", () => {
    const { container } = renderViz(<ScoreComposition match={78} bonus={10} bonusCap={15} pushLine={70} />);
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "排序值构成：AI 匹配分 78，信号加分 10");
    const [match, bonus] = Array.from(container.querySelectorAll<HTMLElement>(".jr-comp__bar > i"));
    expect(match?.style.width).toBe(`${Math.round((78 / 115) * 10000) / 100}%`);
    expect(bonus?.style.width).toBe(`${Math.round((10 / 115) * 10000) / 100}%`);
    expect(screen.getByText("匹配 78")).toBeInTheDocument();
    expect(screen.getByText("+10")).toBeInTheDocument();
    expect(screen.getByText("推送线 70")).toBeInTheDocument();
    expect(screen.getByText("115")).toBeInTheDocument();
  });

  it("puts the number of a segment too narrow to hold it above the bar, not cut inside it", () => {
    // +10 of 115 is 8.7 % of the bar: about 22 px, "+10" does not fit
    const { container } = renderViz(<ScoreComposition match={78} bonus={10} bonusCap={15} pushLine={70} />);
    const out = container.querySelector('[data-testid="comp-out"]') as HTMLElement;
    expect(out).not.toBeNull();
    expect(out).toHaveTextContent("+10");
    expect(out).not.toHaveTextContent("匹配");
    expect(container.querySelector(".jr-comp__b .jr-clip")).toBeNull();
    // the wide match segment keeps its own label inside
    expect(container.querySelector(".jr-comp__m .jr-clip")).toHaveTextContent("匹配 78");
    // nothing too narrow: nothing above the bar
    expect(renderViz(<ScoreComposition match={78} bonus={0} bonusCap={15} pushLine={70} />).container.querySelector('[data-testid="comp-out"]')).toBeNull();
  });

  it("caps the bonus and clamps the match", () => {
    renderViz(<ScoreComposition match={140} bonus={30} bonusCap={15} pushLine={70} />);
    expect(screen.getByText("匹配 100")).toBeInTheDocument();
    expect(screen.getByText("+15")).toBeInTheDocument();
  });

  it("0 + 0: no bonus segment", () => {
    const { container } = renderViz(<ScoreComposition match={0} bonus={0} bonusCap={15} pushLine={70} />);
    expect(container.querySelector(".jr-comp__b")).toBeNull();
    expect(screen.getByText("匹配 0")).toBeInTheDocument();
  });

  it("null: a hatched bar that says the AI has not scored yet", () => {
    const { container } = renderViz(<ScoreComposition match={null} bonus={0} bonusCap={15} pushLine={70} />);
    expect(screen.getByText("AI 还没打分")).toBeInTheDocument();
    expect(container.querySelector(".jr-comp__m")).toBeNull();
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "排序值构成：AI 还没打分");
  });
});

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PlayOnView, useReducedMotion, usePlayOnView } from "@/components/viz/motion";
import { ScoreMeter } from "@/components/viz/score-meter";
import { stepStyle, STEPS } from "@/components/viz/util";

import { renderViz } from "./helpers";

vi.mock("@number-flow/react", () => import("./number-flow-mock").then((m) => m.numberFlowMock));

type Callback = (entries: Array<{ isIntersecting: boolean }>) => void;

/** A controllable IntersectionObserver: `show()` reports the observed elements as visible. */
class FakeObserver {
  static instances: FakeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(private callback: Callback) {
    FakeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  unobserve(): void {}
  show(): void {
    this.callback([{ isIntersecting: true }]);
  }
}

function mockReducedMotion(reduced: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("reduce"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
}

beforeEach(() => {
  FakeObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  mockReducedMotion(false);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function Probe() {
  const { reduced, played } = { reduced: useReducedMotion(), played: usePlayOnView<HTMLDivElement>().played };
  return <span data-testid="probe">{`${reduced}-${played}`}</span>;
}

describe("PlayOnView", () => {
  it("is in the start state until it scrolls into view, then plays once", () => {
    const { container } = render(<PlayOnView>x</PlayOnView>);
    const el = container.firstElementChild as HTMLElement;
    expect(el).toHaveAttribute("data-played", "false");
    expect(FakeObserver.instances).toHaveLength(1);
    expect(FakeObserver.instances[0]?.observed[0]).toBe(el);
    act(() => FakeObserver.instances[0]?.show());
    expect(el).toHaveAttribute("data-played", "true");
    // observed once: after playing, the observer is gone and nothing re-arms it
    expect(FakeObserver.instances[0]?.disconnected).toBe(true);
  });

  it("with reduced motion it is in its final state at once and never observes", () => {
    mockReducedMotion(true);
    const { container } = render(<PlayOnView>x</PlayOnView>);
    expect(container.firstElementChild).toHaveAttribute("data-played", "true");
    expect(FakeObserver.instances).toHaveLength(0);
  });

  it("without IntersectionObserver it shows the final state instead of hiding the chart", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { container } = render(<PlayOnView>x</PlayOnView>);
    expect(container.firstElementChild).toHaveAttribute("data-played", "true");
  });

  it("renders a div on request and keeps the caller's class and attributes", () => {
    const { container } = render(
      <PlayOnView as="div" className="mine" role="img" aria-label="chart">
        x
      </PlayOnView>,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.tagName).toBe("DIV");
    expect(el).toHaveClass("jr", "mine");
    expect(el).toHaveAttribute("aria-label", "chart");
  });

  it("a chart waits for the observer before it is 'played'", () => {
    const { container } = renderViz(<ScoreMeter value={88} pushLine={70} />);
    expect(container.querySelector(".jr-score")).toHaveAttribute("data-played", "false");
    act(() => FakeObserver.instances.forEach((observer) => observer.show()));
    expect(container.querySelector(".jr-score")).toHaveAttribute("data-played", "true");
  });
});

describe("usePlayOnView replay", () => {
  it("goes back to the start state and plays again after a short rest", () => {
    vi.useFakeTimers();
    function Replayable() {
      const { ref: setBox, played, replay } = usePlayOnView<HTMLDivElement>();
      return (
        <div ref={setBox} data-testid="box" data-played={String(played)}>
          <button type="button" onClick={replay}>
            replay
          </button>
        </div>
      );
    }
    render(<Replayable />);
    act(() => FakeObserver.instances[0]?.show());
    expect(screen.getByTestId("box")).toHaveAttribute("data-played", "true");
    act(() => screen.getByRole("button").click());
    expect(screen.getByTestId("box")).toHaveAttribute("data-played", "false");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const latest = FakeObserver.instances.at(-1);
    expect(latest?.disconnected).toBe(false);
    act(() => latest?.show());
    expect(screen.getByTestId("box")).toHaveAttribute("data-played", "true");
  });
});

describe("useReducedMotion", () => {
  it("follows the media query", () => {
    mockReducedMotion(true);
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toMatch(/^true-/);
  });
  it("is false when the user did not ask", () => {
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toMatch(/^false-/);
  });
});

describe("steps utility", () => {
  it("stepStyle sets the cell index the CSS delays by", () => {
    expect(stepStyle(5)).toEqual({ "--n": 5 });
    expect(stepStyle(2, { width: "10px" })).toEqual({ width: "10px", "--n": 2 });
  });
  it("bars grow in 6-8 steps (tokens.md)", () => {
    expect(STEPS.bar).toBeGreaterThanOrEqual(6);
    expect(STEPS.bar).toBeLessThanOrEqual(8);
    expect(STEPS.column).toBeGreaterThanOrEqual(6);
  });
});

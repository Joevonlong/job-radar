import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Delta, PairBars } from "@/components/viz/delta";
import { Freshness } from "@/components/viz/freshness";
import { Funnel } from "@/components/viz/funnel";
import { Led } from "@/components/viz/led";
import { LevelScale } from "@/components/viz/level-scale";
import { SkillOverlap } from "@/components/viz/skill-overlap";
import { Sparkline } from "@/components/viz/sparkline";
import { TermLog } from "@/components/viz/term-log";
import { Ticker } from "@/components/viz/ticker";
import { UptimeStrip } from "@/components/viz/uptime-strip";

import { renderViz } from "./helpers";

vi.mock("@number-flow/react", () => import("./number-flow-mock").then((m) => m.numberFlowMock));

describe("Delta", () => {
  it.each([
    [12, undefined, "▲+12", "up", "jr-delta--up", "上升 12"],
    [-3, undefined, "▼−3", "down", "jr-delta--down", "下降 3"],
    [0, undefined, "■0", "flat", "jr-delta--flat", "持平"],
    [2, "pt" as const, "▲+2pt", "up", "jr-delta--up", "上升 2pt"],
    [18, "%" as const, "▲+18%", "up", "jr-delta--up", "上升 18%"],
  ])("%s%s", (value, unit, text, direction, cls, label) => {
    const { container } = renderViz(<Delta value={value} {...(unit ? { unit } : {})} />);
    const el = container.querySelector(".jr-delta") as HTMLElement;
    expect(el.textContent).toBe(text);
    expect(el).toHaveAttribute("data-direction", direction);
    expect(el).toHaveClass(cls);
    expect(el).toHaveAttribute("aria-label", label);
  });

  it("uses the real minus sign", () => {
    const { container } = renderViz(<Delta value={-3} />);
    expect(container.textContent).toContain("−3");
    expect(container.textContent).not.toContain("-");
  });

  it("invert swaps the colour, not the arrow (failures going up are bad)", () => {
    const { container } = renderViz(<Delta value={4} invert />);
    expect(container.querySelector(".jr-delta")).toHaveClass("jr-delta--down");
    expect(container.textContent).toContain("▲");
  });

  it("null is a dashed — tag, not 'no change'", () => {
    const { container } = renderViz(<Delta value={null} />);
    expect(container.textContent).toBe("—");
    expect(container.querySelector(".jr-delta")).toHaveClass("jr-delta--unknown");
    expect(container.textContent).not.toContain("■");
  });
});

describe("PairBars", () => {
  it("two bars scaled to max, with the numbers written and in the tooltip", () => {
    const { container } = renderViz(<PairBars prev={123} now={135} max={160} />);
    const [prev, now] = Array.from(container.querySelectorAll<HTMLElement>(".jr-pair > i"));
    expect(prev?.style.width).toBe("76.88%");
    expect(now?.style.width).toBe("84.38%");
    expect(container.querySelector(".jr-pair")).toHaveAttribute("data-tip", "上一轮 123 → 本轮 135");
    expect(screen.getByText("123 → 135")).toBeInTheDocument();
  });

  it("defaults the scale to the larger value; zero is no bar, unknown is a dashed track", () => {
    const zero = renderViz(<PairBars prev={0} now={0} />);
    const bars = Array.from(zero.container.querySelectorAll<HTMLElement>(".jr-pair > i"));
    expect(bars.map((b) => b.style.width)).toEqual(["0%", "0%"]);
    zero.unmount();
    const unknown = renderViz(<PairBars prev={null} now={20} />);
    const [prev, now] = Array.from(unknown.container.querySelectorAll<HTMLElement>(".jr-pair > i"));
    expect(prev?.style.borderStyle).toBe("dashed");
    expect(now?.style.width).toBe("100%");
    expect(screen.getByText("— → 20")).toBeInTheDocument();
  });

  it("can show the Delta", () => {
    const { container } = renderViz(<PairBars prev={123} now={135} showDelta />);
    expect(container.querySelector(".jr-delta")?.textContent).toBe("▲+12");
  });
});

describe("Sparkline", () => {
  it("a step line, hatched area, end dot and one hover target per round", () => {
    const { container } = renderViz(<Sparkline values={[12, 14, 13, 18, 22]} />);
    const line = container.querySelector(".jr-spark__ln") as SVGPathElement;
    expect(line.getAttribute("d")).toMatch(/^M0\.0 /);
    expect(line.getAttribute("d")).toMatch(/H30\.0 V/);
    expect(container.querySelector(".jr-spark__dot")).toHaveAttribute("cx", "120.0");
    const hits = container.querySelectorAll(".jr-spark__hit");
    expect(hits).toHaveLength(5);
    expect(hits[4]).toHaveAttribute("data-tip", "第 5 轮：22");
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "最近 5 轮：12 → 22");
  });

  it("flat and all-zero data draw a line", () => {
    for (const values of [[5, 5, 5], [0, 0, 0]]) {
      const { container, unmount } = renderViz(<Sparkline values={values} height={34} />);
      expect(container.querySelector(".jr-spark__ln")?.getAttribute("d")).toContain("V17.0");
      unmount();
    }
  });

  it("a single round is the words \"1 轮\", not a lonely dot", () => {
    const { container } = renderViz(<Sparkline values={[7]} />);
    expect(container.querySelector(".jr-spark__dot")).toBeNull();
    expect(screen.getByTestId("spark-single")).toHaveTextContent("1 轮");
  });

  it("a null breaks the line instead of drawing 0", () => {
    const { container } = renderViz(<Sparkline values={[3, 6, null, 9, 12]} />);
    const d = container.querySelector(".jr-spark__ln")?.getAttribute("d") ?? "";
    expect(d.match(/M/g)).toHaveLength(2);
    expect(container.querySelectorAll(".jr-spark__hit")[2]).toHaveAttribute("data-tip", "第 3 轮：—");
  });

  it("bridgeGaps: one continuous step line through the known days, at their own places, no lonely dots", () => {
    const { container } = renderViz(<Sparkline values={[4, null, null, 8, 9, null, 7]} width={120} bridgeGaps />);
    const d = container.querySelector(".jr-spark__ln")?.getAttribute("d") ?? "";
    expect(d.match(/M/g)).toHaveLength(1);
    // days 0, 3, 4 and 6 of 7 slots over 120px (20px each): the bridged days keep their x
    expect(d).toMatch(/^M0\.0 /);
    expect(d).toContain("H60.0");
    expect(d).toContain("H80.0");
    expect(d).toContain("H120.0");
    expect(container.querySelector(".jr-spark__pt")).toBeNull();
    expect(container.querySelector(".jr-spark__dot")).toHaveAttribute("cx", "120.0");
    // the day without a value still says so
    expect(container.querySelectorAll(".jr-spark__hit")[1]).toHaveAttribute("data-tip", "第 2 轮：—");
  });

  it("spans the whole width: a gap keeps its place and takes no room from the others", () => {
    const { container } = renderViz(<Sparkline values={[4, null, null, 8, 9]} width={100} />);
    const d = container.querySelector(".jr-spark__ln")?.getAttribute("d") ?? "";
    // 5 slots over 100px: the run of 8 and 9 starts at slot 3 (x = 75), not right after the first value
    expect(d).toMatch(/^M75\.0 /);
    expect(d).toContain("H100.0");
    expect(container.querySelector(".jr-spark__dot")).toHaveAttribute("cx", "100.0");
    // the lonely first value is a point at its own slot, not a line
    expect(container.querySelector(".jr-spark__pt")).toHaveAttribute("cx", "0.0");
    expect(container.querySelectorAll(".jr-spark__hit")).toHaveLength(5);
  });

  it("zero known values: no line, no dot, only the dash", () => {
    const { container } = renderViz(<Sparkline values={[null, null, null]} width={100} />);
    expect(container.querySelector(".jr-spark__ln")).toBeNull();
    expect(container.querySelector(".jr-spark__dot")).toBeNull();
    expect(container.textContent).toBe("—");
  });

  it("one known value among gaps: the words \"1 轮\", no line, area or dot", () => {
    const { container } = renderViz(<Sparkline values={[null, null, 6, null, null]} width={100} />);
    expect(container.querySelector(".jr-spark__ln")).toBeNull();
    expect(container.querySelector("path")).toBeNull();
    expect(container.querySelector(".jr-spark__dot")).toBeNull();
    expect(screen.getByTestId("spark-single")).toHaveTextContent("1 轮");
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "最近 5 轮：6 → 6");
  });

  it("two known values: a step line between them over the full width", () => {
    const { container } = renderViz(<Sparkline values={[3, 9, null, null, null]} width={100} />);
    const d = container.querySelector(".jr-spark__ln")?.getAttribute("d") ?? "";
    expect(d).toMatch(/^M0\.0 [\d.]+ H25\.0 V[\d.]+$/);
    expect(container.querySelector(".jr-spark__dot")).toHaveAttribute("cx", "25.0");
  });

  it("no data and all-unknown say so", () => {
    expect(renderViz(<Sparkline values={[]} />).container.textContent).toBe("—");
    expect(renderViz(<Sparkline values={[null, null]} />).container.querySelector(".jr-spark--empty")).not.toBeNull();
    expect(screen.getAllByRole("img", { name: "没有数据" }).length).toBeGreaterThan(0);
  });

  it("percent format in the tooltip", () => {
    const { container } = renderViz(<Sparkline values={[36, 38.4]} format="percent" />);
    expect(container.querySelectorAll(".jr-spark__hit")[1]).toHaveAttribute("data-tip", "第 2 轮：38%");
  });
});

describe("LevelScale", () => {
  const states = (container: HTMLElement): string[] => Array.from(container.querySelectorAll(".jr-lvl i")).map((i) => i.className.replace(/\s+/g, " ").trim());

  it("B1 needing B2: solid up to B1, the requirement is a red-framed hatched gap", () => {
    const { container } = renderViz(<LevelScale mine="B1" required="B2" />);
    expect(states(container)).toEqual(["jr-on", "jr-on", "jr-on", "jr-gap jr-req", "", ""]);
    expect(screen.getByText("你")).toBeInTheDocument();
    expect(screen.getByText("要求")).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "语言等级：你 B1，要求 B2，差 1 级");
    expect(container.querySelector(".jr-lvl")).toHaveAttribute("data-tip", "你 B1 · 要求 B2 · 差 1 级");
  });

  it("A2 needing C1 has a gap of three", () => {
    const { container } = renderViz(<LevelScale mine="A2" required="C1" />);
    expect(states(container)).toEqual(["jr-on", "jr-on", "jr-gap", "jr-gap", "jr-gap jr-req", ""]);
    expect(container.querySelector(".jr-lvl")).toHaveAttribute("data-gap", "3");
  });

  it("above the requirement: no gap", () => {
    const { container } = renderViz(<LevelScale mine="C2" required="B2" />);
    expect(states(container)).toEqual(["jr-on", "jr-on", "jr-on", "jr-on jr-req", "jr-on", "jr-on"]);
    expect(container.querySelector(".jr-lvl")).toHaveAttribute("data-gap", "0");
  });

  it("same level carries both captions", () => {
    renderViz(<LevelScale mine="B2" required="B2" />);
    expect(screen.getByText("你/要求")).toBeInTheDocument();
  });

  it("no requirement; no level set (cells stay empty, no gap is invented)", () => {
    const own = renderViz(<LevelScale mine="B1" />);
    expect(states(own.container)).toEqual(["jr-on", "jr-on", "jr-on", "", "", ""]);
    own.unmount();
    const unset = renderViz(<LevelScale mine={null} required="B2" />);
    expect(states(unset.container)).toEqual(["", "", "", "jr-req", "", ""]);
    expect(unset.container.querySelector(".jr-lvl--unset")).not.toBeNull();
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "语言等级：未填写");
  });
});

describe("SkillOverlap", () => {
  const skills = [
    { name: "Python", have: true },
    { name: "LLMs", have: true },
    { name: "RAG", have: true },
    { name: "Kubernetes", have: true },
    { name: "AWS", have: false },
    { name: "LangChain", have: false },
    { name: "Vector DB", have: false },
  ];

  it("4/7 57% with one cell per skill and the matches in the tooltip", () => {
    const { container } = renderViz(<SkillOverlap skills={skills} />);
    expect(container.querySelectorAll(".jr-ovl__b > i")).toHaveLength(7);
    expect(container.querySelectorAll(".jr-ovl__b > i.jr-on")).toHaveLength(4);
    expect(screen.getByText("4/7")).toBeInTheDocument();
    expect(screen.getByText("57%")).toBeInTheDocument();
    expect(container.querySelector(".jr-ovl")).toHaveAttribute("data-tip", "和画像技能重合 4/7：Python, LLMs, RAG, Kubernetes");
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "技能重合 4/7: Python, LLMs, RAG, Kubernetes");
  });

  it("0 of 3 and 3 of 3", () => {
    const none = renderViz(<SkillOverlap skills={[{ name: "GCP", have: false }, { name: "Azure", have: false }, { name: "JAX", have: false }]} />);
    expect(none.container.querySelectorAll(".jr-ovl__b > i.jr-on")).toHaveLength(0);
    expect(none.getByText("0/3")).toBeInTheDocument();
    expect(none.getByText("0%")).toBeInTheDocument();
    none.unmount();
    const all = renderViz(<SkillOverlap skills={[{ name: "A", have: true }, { name: "B", have: true }]} />);
    expect(all.getByText("2/2")).toBeInTheDocument();
    expect(all.getByText("100%")).toBeInTheDocument();
  });

  it("no skills listed is 未披露技能, not 0/0", () => {
    const { container } = renderViz(<SkillOverlap skills={[]} />);
    expect(container.textContent).toBe("未披露技能");
    expect(container.textContent).not.toContain("0/0");
  });
});

describe("Freshness", () => {
  const NOW = new Date("2026-10-08T12:00:00Z");
  const ago = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000);
  const props = { now: NOW, decayHours: 72, warnHours: 24, timeZone: "Europe/Berlin" } as const;
  const width = (container: HTMLElement): string => (container.querySelector(".jr-fresh__b > i") as HTMLElement).style.width;

  it("new job: long green bar and 刚刚 / hours written next to it", () => {
    const { container } = renderViz(<Freshness firstSeenAt={ago(0)} {...props} />);
    expect(width(container)).toBe("100%");
    expect(container.querySelector(".jr-fresh")).toHaveAttribute("data-stale", "false");
    expect(container.textContent).toBe("刚刚");
    const two = renderViz(<Freshness firstSeenAt={ago(2)} {...props} />);
    expect(two.container.textContent).toBe("2 小时前");
    expect(width(two.container)).toBe("97.22%");
  });

  it("past the warning hours it is yellow (data-stale) and the meter says so", () => {
    const { container } = renderViz(<Freshness firstSeenAt={ago(26)} {...props} />);
    expect(container.querySelector(".jr-fresh")).toHaveAttribute("data-stale", "true");
    expect(container.textContent).toBe("昨天");
    expect(screen.getByRole("meter").getAttribute("aria-valuetext")).toContain("已超过 24 小时");
  });

  it("never gets shorter than 6%, even long past the decay", () => {
    expect(width(renderViz(<Freshness firstSeenAt={ago(70)} {...props} />).container)).toBe("6%");
    expect(width(renderViz(<Freshness firstSeenAt={ago(500)} {...props} />).container)).toBe("6%");
  });

  it("the decay and warning hours come from the props (ui.yaml), not constants", () => {
    const a = renderViz(<Freshness firstSeenAt={ago(10)} now={NOW} decayHours={20} warnHours={5} />);
    expect(width(a.container)).toBe("50%");
    expect(a.container.querySelector(".jr-fresh")).toHaveAttribute("data-stale", "true");
  });

  it("a first-seen time in the future counts as brand new", () => {
    expect(width(renderViz(<Freshness firstSeenAt={ago(-3)} {...props} />).container)).toBe("100%");
  });

  it("unknown is a dashed empty bar and —, not 'brand new'", () => {
    const { container } = renderViz(<Freshness firstSeenAt={null} {...props} />);
    expect(container.textContent).toBe("—");
    expect(container.querySelector(".jr-fresh--unknown")).not.toBeNull();
    expect(screen.queryByRole("meter")).toBeNull();
  });
});

describe("Funnel", () => {
  const steps = [
    { key: "a", label: "抓取", value: 458 },
    { key: "b", label: "通过过滤", value: 135 },
    { key: "c", label: "≥ 70", value: 24 },
    { key: "d", label: "推送", value: 6 },
  ];

  it("bar widths relative to the first stage and the conversion between stages", () => {
    const { container } = renderViz(<Funnel steps={steps} />);
    const widths = Array.from(container.querySelectorAll<HTMLElement>(".jr-fun__bar")).map((b) => b.style.width);
    expect(widths).toEqual(["100%", "29.48%", "5.24%", "4%"]); // the last is lifted to the 4% minimum
    expect(Array.from(container.querySelectorAll(".jr-fun__cv")).map((e) => e.textContent)).toEqual(["↓ 29%", "↓ 18%", "↓ 25%"]);
    expect(Array.from(container.querySelectorAll(".jr-fun__v .jr-sr")).map((e) => e.textContent)).toEqual(["458", "135", "24", "6"]);
  });

  it("has an accessible summary and a tooltip per stage", () => {
    const { container } = renderViz(<Funnel steps={steps} />);
    expect(screen.getByRole("group")).toHaveAttribute("aria-label", "漏斗：抓取 458, 通过过滤 135, ≥ 70 24, 推送 6");
    expect(container.querySelector(".jr-fun__bar")).toHaveAttribute("data-tip", "抓取：458");
  });

  it("zero stages: no bars (empty tracks) and an unknown conversion, not NaN", () => {
    const { container } = renderViz(<Funnel steps={[{ key: "a", label: "抓取", value: 0 }, { key: "b", label: "过滤", value: 0 }]} />);
    expect(Array.from(container.querySelectorAll<HTMLElement>(".jr-fun__bar")).map((b) => b.dataset.zero)).toEqual(["true", "true"]);
    expect(container.querySelector(".jr-fun__cv")?.textContent).toBe("↓ —");
    expect(container.textContent).not.toContain("NaN");
  });

  it("a single stage has no conversion", () => {
    expect(renderViz(<Funnel steps={[steps[0] as (typeof steps)[number]]} />).container.querySelector(".jr-fun__cv")).toBeNull();
  });
});

describe("UptimeStrip", () => {
  const cellStates = (container: HTMLElement): string[] => Array.from(container.querySelectorAll(".jr-up > i")).map((i) => i.getAttribute("data-state") ?? "");

  it("one block per cycle with the outcome in the tooltip, summary written", () => {
    const { container } = renderViz(<UptimeStrip states={["ok", "ok", "warn", "fail", "ok"]} />);
    expect(cellStates(container)).toEqual(["ok", "ok", "warn", "fail", "ok"]);
    expect(container.querySelectorAll(".jr-up > i")[4]).toHaveAttribute("data-tip", "倒数第 1 轮：正常");
    expect(container.querySelectorAll(".jr-up > i")[2]).toHaveAttribute("data-tip", "倒数第 3 轮：降级");
    expect(screen.getByText("3/5 正常")).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "最近 5 轮：3 轮正常，1 轮降级，1 轮失败");
  });

  it("keeps the last `count` cycles (ui.yaml health_cycles)", () => {
    const states = ["fail", "fail", "ok", "ok", "ok"] as const;
    const { container } = renderViz(<UptimeStrip states={[...states]} count={3} />);
    expect(cellStates(container)).toEqual(["ok", "ok", "ok"]);
  });

  it("missing older cycles are dashed empty cells, not green", () => {
    const { container } = renderViz(<UptimeStrip states={["ok", "fail"]} count={5} />);
    expect(cellStates(container)).toEqual(["none", "none", "none", "ok", "fail"]);
    expect(screen.getByText("1/2 正常")).toBeInTheDocument();
  });

  it("no data at all", () => {
    const { container } = renderViz(<UptimeStrip states={[]} count={4} />);
    expect(cellStates(container)).toEqual(["none", "none", "none", "none"]);
    expect(screen.getByText("无记录")).toBeInTheDocument();
    expect(container.textContent).not.toContain("0/0");
  });

  it("a null cycle is no data", () => {
    expect(cellStates(renderViz(<UptimeStrip states={["ok", null, "ok"]} />).container)).toEqual(["ok", "none", "ok"]);
  });
});

describe("Led", () => {
  it.each([
    ["good", "正常"],
    ["warn", "降级"],
    ["bad", "失败"],
    ["idle", "待命"],
  ] as const)("%s says %s in words", (tone, word) => {
    const { container } = renderViz(<Led tone={tone} />);
    expect(container.textContent).toBe(word);
    expect(container.querySelector(".jr-led")).toHaveAttribute("data-tone", tone);
  });

  it("live breathes, custom label, and label=false keeps an accessible name", () => {
    const live = renderViz(<Led tone="good" live label="运行中" />);
    expect(live.container.querySelector(".jr-led")).toHaveClass("jr-led--live");
    expect(live.container.textContent).toBe("运行中");
    live.unmount();
    renderViz(<Led tone="bad" label={false} />);
    expect(screen.getByRole("img", { name: "失败" })).toBeInTheDocument();
  });
});

describe("Ticker", () => {
  const items = [
    { key: "1", tag: "NEW", text: "Senior Applied AI Engineer", accent: "€95–120k" },
    { key: "2", tag: "RUN", text: "晚轮 17:00 完成" },
    { key: "3", tag: "SRC", text: "guest 熔断" },
  ];

  it("labelled group, LIVE tag, the list twice for a seamless loop (the copy hidden from assistive technology)", () => {
    const { container } = renderViz(<Ticker items={items} />);
    expect(screen.getByRole("group", { name: "本轮新岗位" })).toBeInTheDocument();
    expect(screen.getByText("LIVE")).toBeInTheDocument();
    expect(screen.getAllByText(/Senior Applied AI Engineer/)).toHaveLength(2);
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toContain("Senior Applied AI Engineer");
    expect(container.querySelector(".jr-ticker em")?.textContent).toBe("€95–120k");
  });

  it("shows at most maxItems (ui.yaml ticker_max_items)", () => {
    renderViz(<Ticker items={items} maxItems={2} />);
    expect(screen.queryByText(/guest 熔断/)).toBeNull();
    expect(screen.getAllByText(/晚轮 17:00 完成/)).toHaveLength(2);
  });

  it("empty: says so and does not scroll", () => {
    const { container } = renderViz(<Ticker items={[]} />);
    expect(screen.getByText("暂无新动态")).toBeInTheDocument();
    expect(container.querySelector(".jr-ticker--static")).not.toBeNull();
  });
});

describe("TermLog", () => {
  it("a log with one line per entry, typed out one after the other, cursor on the last", () => {
    const { container } = renderViz(<TermLog lines={[{ prefix: "17:00", text: "cycle start", tone: "amber" }, { text: "filter 135 passed", tone: "green" }]} />);
    expect(screen.getByRole("log", { name: "运行日志" })).toBeInTheDocument();
    const lines = container.querySelectorAll(".jr-term__line");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveClass("jr-term__amber");
    expect(lines[1]).toHaveClass("jr-term__green", "jr-term__cursor");
    expect(lines[0]?.textContent).toBe("17:00 cycle start");
    expect((container.querySelectorAll(".jr-term__txt")[1] as HTMLElement).style.getPropertyValue("--k")).toBe("1");
  });

  it("cursor can be switched off, an empty log renders an empty block", () => {
    expect(renderViz(<TermLog lines={[{ text: "x" }]} cursor={false} />).container.querySelector(".jr-term__cursor")).toBeNull();
    expect(renderViz(<TermLog lines={[]} />).container.querySelectorAll(".jr-term__line")).toHaveLength(0);
  });
});

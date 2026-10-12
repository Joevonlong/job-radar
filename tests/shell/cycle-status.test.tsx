import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import { CycleStatusDotView, CycleStatusView } from "@/components/shell/cycle-status";
import type { ShellStatus } from "@/lib/shell/status-schema";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const wrap = (node: React.ReactNode, locale: "en" | "zh" = "zh") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh} timeZone="Europe/Berlin">
    {node}
  </NextIntlClientProvider>
);

// 05:00 Berlin; the next slot is 07:00 the same day
const base: ShellStatus = {
  now: "2026-10-08T03:00:00.000Z",
  state: "idle",
  timezone: "Europe/Berlin",
  next: { kind: "weekday_morning", at: "2026-10-08T05:00:00.000Z" },
  cycle: { id: 7, kind: "weekday_evening", status: "succeeded", failedSteps: [], partialSteps: [] },
  sources: { ok: 14, failed: 0, circuitOpen: 1 },
  runner: { online: true, ageSeconds: 12 },
  aiWorker: { expected: true, online: true, ageSeconds: 20 },
  counts: { today: 4, jobs: 135, pipeline: 6, favorites: 3, sourcesAlert: 1 },
  progress: null,
};

describe("CycleStatusView", () => {
  it("idle: next slot and how many sources are ok / behind an open circuit", () => {
    render(wrap(<CycleStatusView status={base} />));
    const box = screen.getByTestId("cycle-status");
    expect(box).toHaveAttribute("data-state", "idle");
    expect(box).toHaveTextContent("IDLE");
    expect(box).toHaveTextContent("下一轮 07:00");
    expect(screen.getByTestId("cycle-status-sources")).toHaveTextContent("14 来源 ok · 1 熔断");
  });

  it("idle: shows a weekday when the next slot is not today, says so when nothing is scheduled, reports failed sources", () => {
    const { rerender } = render(wrap(<CycleStatusView status={{ ...base, next: { kind: "weekday_morning", at: "2026-10-09T05:00:00.000Z" } }} />, "en"));
    expect(screen.getByTestId("cycle-status")).toHaveTextContent("Next run Fri");
    rerender(wrap(<CycleStatusView status={{ ...base, next: null, sources: { ok: 3, failed: 2, circuitOpen: 0 } }} />, "en"));
    expect(screen.getByTestId("cycle-status")).toHaveTextContent("No scheduled run");
    expect(screen.getByTestId("cycle-status-sources")).toHaveTextContent("3 sources ok · 0 open · 2 failed");
  });

  it("running (AI part): kind, a 10-cell bar with the real counts, and the phase", () => {
    const running: ShellStatus = { ...base, state: "running", progress: { phase: "ai", status: "running", kind: "weekday_evening", done: 62, total: 135 } };
    render(wrap(<CycleStatusView status={running} />));
    const box = screen.getByTestId("cycle-status");
    expect(box).toHaveAttribute("data-state", "running");
    expect(box).toHaveTextContent("RUNNING 晚轮");
    expect(screen.getByTestId("cycle-status-count")).toHaveTextContent("62/135");
    expect(box).toHaveTextContent("AI 打分");
    const bar = within(box).getByRole("meter");
    expect(bar).toHaveAttribute("aria-label", "AI 打分：62 / 135");
    // SegBlocks reads in percent: 62/135 = 45.9%, 10 cells -> 5 lit
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeCloseTo(45.9, 1);
    expect(bar.querySelectorAll("i")).toHaveLength(10);
    expect(bar.querySelectorAll("i.jr-on")).toHaveLength(5);
  });

  it("running (fetch phase, AI queued) and an empty total never divide by zero", () => {
    const { rerender } = render(wrap(<CycleStatusView status={{ ...base, state: "running", progress: { phase: "fetch", status: "running", kind: "manual", done: 3, total: 12 } }} />));
    expect(screen.getByTestId("cycle-status")).toHaveTextContent("RUNNING 手动轮");
    expect(screen.getByTestId("cycle-status")).toHaveTextContent("抓取");
    rerender(wrap(<CycleStatusView status={{ ...base, state: "running", progress: { phase: "ai", status: "pending", kind: null, done: 0, total: 0 } }} />));
    expect(screen.getByTestId("cycle-status")).toHaveTextContent("AI 排队中");
    expect(screen.getByTestId("cycle-status-count")).toHaveTextContent("0/0");
    // no total: unknown cells, never an empty (0%) bar
    expect(within(screen.getByTestId("cycle-status")).queryByRole("meter")).toBeNull();
    expect(screen.getByTestId("cycle-status").querySelectorAll("i.jr-unk")).toHaveLength(10);
  });

  it("failed: says the last cycle failed and still shows the next slot", () => {
    render(wrap(<CycleStatusView status={{ ...base, state: "failed", cycle: { id: 7, kind: "weekday_evening", status: "failed", failedSteps: [], partialSteps: [] } }} />));
    const box = screen.getByTestId("cycle-status");
    expect(box).toHaveAttribute("data-state", "failed");
    expect(box).toHaveTextContent("FAILED 晚轮");
    expect(box).toHaveTextContent("上一轮失败");
    expect(box).toHaveTextContent("下一轮 07:00");
  });

  it("partial with failed steps: names them and links to /sources instead of an idle face", () => {
    render(wrap(<CycleStatusView status={{ ...base, cycle: { id: 8, kind: "weekday_morning", status: "partial", failedSteps: ["pipeline", "filter", "ai"], partialSteps: [] } }} />));
    const box = screen.getByTestId("cycle-status");
    expect(box).toHaveAttribute("data-state", "partial");
    expect(box).toHaveTextContent("部分失败 早轮");
    expect(screen.getByTestId("cycle-status-steps")).toHaveTextContent("处理 / 过滤 / 打分 失败");
    expect(screen.getByTestId("cycle-status-why")).toHaveAttribute("href", "/sources");
    expect(box).toHaveTextContent("下一轮 07:00");
  });

  it("partial only because a source failed keeps the idle face (its sources line says it)", () => {
    render(wrap(<CycleStatusView status={{ ...base, cycle: { id: 8, kind: "weekday_morning", status: "partial", failedSteps: [], partialSteps: ["collect"] } }} />));
    expect(screen.getByTestId("cycle-status")).toHaveAttribute("data-state", "idle");
  });

  it("renders a placeholder until the first status arrives", () => {
    render(wrap(<CycleStatusView status={null} />, "en"));
    expect(screen.getByTestId("cycle-status")).toHaveAttribute("data-state", "loading");
    expect(screen.getByTestId("cycle-status")).toHaveTextContent("Loading…");
  });
});

describe("CycleStatusView offline", () => {
  const silent: ShellStatus = { ...base, runner: { online: false, ageSeconds: 16 * 60 } };

  it("a stale runner heartbeat is a red OFFLINE with the age, never a green IDLE", () => {
    render(wrap(<CycleStatusView status={silent} />));
    const box = screen.getByTestId("cycle-status");
    expect(box).toHaveAttribute("data-state", "offline");
    expect(box).toHaveTextContent("OFFLINE");
    expect(box).not.toHaveTextContent("IDLE");
    expect(screen.getByTestId("cycle-status-offline-detail")).toHaveTextContent("runner 无心跳 16 分钟");
  });

  it("no heartbeat at all says so, in English too", () => {
    render(wrap(<CycleStatusView status={{ ...base, runner: { online: false, ageSeconds: null } }} />, "en"));
    expect(screen.getByTestId("cycle-status-offline-detail")).toHaveTextContent("runner: no heartbeat yet");
  });

  it("a running AI phase is not offline while the ai-worker is alive, even without a runner", () => {
    const status: ShellStatus = { ...silent, state: "running", progress: { phase: "ai", status: "running", kind: "manual", done: 1, total: 5 } };
    render(wrap(<CycleStatusView status={status} />));
    expect(screen.getByTestId("cycle-status")).toHaveAttribute("data-state", "running");
  });

  it("a silent ai-worker is a warning line under the normal face (and under the offline one)", () => {
    const aiDown: ShellStatus = { ...base, aiWorker: { expected: true, online: false, ageSeconds: 300 } };
    const { rerender } = render(wrap(<CycleStatusView status={aiDown} />));
    expect(screen.getByTestId("cycle-status")).toHaveAttribute("data-state", "idle");
    expect(screen.getByTestId("cycle-status-ai-offline")).toHaveTextContent("AI worker 无心跳 5 分钟");
    rerender(wrap(<CycleStatusView status={{ ...aiDown, runner: { online: false, ageSeconds: 400 } }} />));
    expect(screen.getByTestId("cycle-status-ai-offline")).toBeInTheDocument();
    // AI in the container: no worker to wait for, no warning
    rerender(wrap(<CycleStatusView status={{ ...aiDown, aiWorker: { expected: false, online: false, ageSeconds: null } }} />));
    expect(screen.queryByTestId("cycle-status-ai-offline")).toBeNull();
  });
});

describe("CycleStatusDotView (phone top bar)", () => {
  it("shows a bare green dot when all is well and a short red word when the runner is silent", () => {
    const { rerender } = render(wrap(<CycleStatusDotView status={base} />));
    expect(screen.getByTestId("cycle-status-dot")).toHaveAttribute("data-state", "idle");
    expect(screen.getByTestId("cycle-status-dot")).toHaveTextContent(/^●$/);
    rerender(wrap(<CycleStatusDotView status={{ ...base, runner: { online: false, ageSeconds: 900 } }} />));
    expect(screen.getByTestId("cycle-status-dot")).toHaveAttribute("data-state", "offline");
    expect(screen.getByTestId("cycle-status-dot")).toHaveTextContent("离线");
    expect(screen.getByTestId("cycle-status-dot")).toHaveAttribute("href", "/sources");
  });

  // WCAG 2.5.3: what a screen reader calls the dot starts with the word drawn on it, in the page's language
  const faces: Array<{ name: string; status: ShellStatus; state: string }> = [
    { name: "offline", state: "offline", status: { ...base, runner: { online: false, ageSeconds: 900 } } },
    { name: "failed", state: "failed", status: { ...base, state: "failed" } },
    { name: "running", state: "running", status: { ...base, state: "running", progress: { phase: "fetch", status: "running", kind: "weekday_evening", done: 3, total: 9 } } },
    { name: "partial", state: "partial", status: { ...base, cycle: { id: 8, kind: "weekday_morning", status: "partial", failedSteps: ["pipeline"], partialSteps: [] } } },
    { name: "ai worker offline", state: "ai-offline", status: { ...base, aiWorker: { expected: true, online: false, ageSeconds: 300 } } },
  ];

  describe.each(["en", "zh"] as const)("accessible name (%s)", (locale) => {
    it.each(faces)("$name: starts with the visible word, then says what it means", ({ status, state }) => {
      render(wrap(<CycleStatusDotView status={status} />, locale));
      const dot = screen.getByTestId("cycle-status-dot");
      expect(dot).toHaveAttribute("data-state", state);
      const word = (dot.textContent ?? "").replace("●", "").trim();
      expect(word).not.toBe("");
      const label = dot.getAttribute("aria-label") ?? "";
      expect(label.startsWith(`${word} · `)).toBe(true);
      // a dedicated sentence, not the desktop box's terminal word (OFFLINE / FAILED / RUNNING)
      expect(label).not.toMatch(/OFFLINE|FAILED|RUNNING/);
      expect(screen.getByRole("link", { name: label })).toBe(dot);
    });

    it("idle: no word on the dot, so the name is the status label and what it means", () => {
      render(wrap(<CycleStatusDotView status={base} />, locale));
      expect(screen.getByTestId("cycle-status-dot").getAttribute("aria-label")).toBe(locale === "en" ? "Cycle status: idle" : "处理轮状态：空闲");
    });
  });
});

describe("CycleStatusView: a silent runner and a partly failed cycle", () => {
  it("shows OFFLINE and the partial failure with its steps, both at once", () => {
    const status: ShellStatus = {
      ...base,
      runner: { online: false, ageSeconds: 55 * 60 },
      cycle: { id: 8, kind: "weekday_morning", status: "partial", failedSteps: ["pipeline", "filter"], partialSteps: ["notify"] },
    };
    render(wrap(<CycleStatusView status={status} />));
    const box = screen.getByTestId("cycle-status");
    expect(box).toHaveAttribute("data-state", "offline");
    expect(box).toHaveTextContent("OFFLINE");
    expect(screen.getByTestId("cycle-status-partial")).toHaveTextContent("部分失败 早轮");
    expect(screen.getByTestId("cycle-status-steps")).toHaveTextContent("处理 / 过滤 / 推送 失败");
    expect(screen.getByTestId("cycle-status-why")).toHaveAttribute("href", "/sources");
  });

  it("an offline runner with a clean cycle has no partial lines", () => {
    render(wrap(<CycleStatusView status={{ ...base, runner: { online: false, ageSeconds: 16 * 60 } }} />));
    expect(screen.queryByTestId("cycle-status-partial")).toBeNull();
  });
});

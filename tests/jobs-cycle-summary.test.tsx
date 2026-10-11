import { render, screen } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import en from "../messages/en.json";
import zh from "../messages/zh.json";

const state = vi.hoisted(() => ({ locale: "zh" as "zh" | "en" }));

vi.mock("next-intl/server", () => {
  const messages = { zh, en } as const;
  return {
    getTranslations: async (namespace: string) => createTranslator({ locale: state.locale, messages: messages[state.locale] as never, namespace: namespace as never }),
    getFormatter: async () => ({ dateTime: () => "07:09" }),
  };
});

import { CycleSummaryStrip, TodayCyclesList } from "@/components/jobs/cycle-summary";
import { readCycleSteps } from "@/lib/cycle/step-health";
import type { CycleSummary } from "@/lib/db/queries/today";

const NOW = new Date("2026-10-08T07:30:00Z");

function cycle(over: Partial<CycleSummary> = {}): CycleSummary {
  return {
    id: 9,
    kind: "weekday_morning",
    status: "succeeded",
    startedAt: NOW,
    finishedAt: NOW,
    channels: [{ channelId: "greenhouse", family: "ats", runs: 1, fetched: 987, newCount: 231, outcome: "ok", errorCode: null, circuitOpenUntil: null }],
    newCount: 0,
    mergedCount: null,
    fetched: 987,
    failedChannels: 0,
    passedCount: 0,
    qualifiedCount: 0,
    steps: [],
    unprocessed: 0,
    ...over,
  };
}

const failedSteps = readCycleSteps({
  steps: [
    { name: "collect", status: "ok" },
    { name: "pipeline", status: "failed", error: "ConfigError: skills[3].aliases: unknown key" },
    { name: "filter", status: "failed" },
    { name: "ai", status: "failed" },
    { name: "notify", status: "ok" },
  ],
});

describe("the cycle strip of Today", () => {
  it("a finished cycle reads 'finished' with no warning", async () => {
    state.locale = "zh";
    render(await CycleSummaryStrip({ summary: cycle({ steps: readCycleSteps({ steps: [{ name: "pipeline", status: "ok" }] }) }), next: null, timezone: "Europe/Berlin", now: NOW }));
    const strip = screen.getByTestId("cycle-summary");
    expect(strip).toHaveAttribute("data-tone", "ok");
    expect(strip.textContent).toContain("已完成 07:09");
    expect(screen.queryByTestId("cycle-problem")).toBeNull();
  });

  it("a cycle whose steps failed never reads 'finished': it names the failed steps, says what is waiting and what to do", async () => {
    state.locale = "zh";
    render(await CycleSummaryStrip({ summary: cycle({ status: "partial", steps: failedSteps, unprocessed: 231 }), next: null, timezone: "Europe/Berlin", now: NOW }));
    const strip = screen.getByTestId("cycle-summary");
    expect(strip).toHaveAttribute("data-tone", "warn");
    expect(strip.textContent).toContain("部分失败：处理 / 过滤 / 打分失败");
    expect(strip.textContent).not.toContain("已完成");
    expect(screen.getByTestId("cycle-unprocessed")).toHaveAttribute("data-count", "231");
    expect(screen.getByTestId("cycle-unprocessed")).toHaveTextContent("本轮抓到 987 条，其中 231 条还没处理，下一轮会补处理");
    expect(screen.getByTestId("cycle-problem-link")).toHaveAttribute("href", "/sources");
    // plain words, no dev path or raw code
    expect(screen.getByTestId("cycle-problem").textContent).not.toMatch(/spec\/guides|ai_failed|ConfigError/);
  });

  it("a push that only half went out is named in the explanation too, and the pushed block says 'not processed'", async () => {
    state.locale = "zh";
    const steps = readCycleSteps({ steps: [{ name: "collect", status: "ok" }, { name: "notify", status: "partial" }] });
    render(await CycleSummaryStrip({ summary: cycle({ status: "partial", steps }), next: null, timezone: "Europe/Berlin", now: NOW }));
    expect(screen.getByTestId("cycle-summary").textContent).toContain("部分失败：推送失败");
    const line = document.querySelector('[data-testid="cycle-problem"] li[data-step="notify"]');
    expect(line).toHaveAttribute("data-status", "partial");
    expect(line).toHaveTextContent("Telegram 推送只发出了一部分");
  });

  it("English wording", async () => {
    state.locale = "en";
    render(await CycleSummaryStrip({ summary: cycle({ status: "partial", steps: failedSteps, unprocessed: 231 }), next: null, timezone: "Europe/Berlin", now: NOW }));
    expect(screen.getByTestId("cycle-summary").textContent).toContain("partly failed: Process / Filter / Scoring");
    expect(screen.getByTestId("cycle-unprocessed")).toHaveTextContent("fetched 987 postings; 231 of them are not processed yet");
  });

  it("a partial cycle with only failed sources says so (no step list)", async () => {
    state.locale = "zh";
    render(await CycleSummaryStrip({ summary: cycle({ status: "partial", failedChannels: 1, steps: readCycleSteps({ steps: [{ name: "collect", status: "partial" }, { name: "pipeline", status: "ok" }] }) }), next: null, timezone: "Europe/Berlin", now: NOW }));
    expect(screen.getByTestId("cycle-summary").textContent).toContain("部分失败：有来源没抓成功");
    expect(screen.queryByTestId("cycle-problem")).toBeNull();
  });

  it("the list of today's cycles shows the waiting count instead of 0 new / 0 passed", async () => {
    state.locale = "zh";
    render(await TodayCyclesList({ cycles: [cycle({ status: "partial", steps: failedSteps, unprocessed: 231 }), cycle({ id: 8 })], timezone: "Europe/Berlin" }));
    const rows = screen.getAllByTestId("today-cycle");
    expect(rows[0]?.textContent).toContain("待处理");
    expect(rows[0]?.textContent).toContain("231");
    expect(rows[0]?.textContent).not.toContain("通过过滤");
    expect(rows[1]?.textContent).toContain("通过过滤");
  });
});

import { render } from "@testing-library/react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import en from "../messages/en.json";
import zh from "../messages/zh.json";

const state = vi.hoisted(() => ({ locale: "zh" as "zh" | "en" }));

vi.mock("next-intl/server", () => {
  const messages = { zh, en } as const;
  return {
    getTranslations: async (namespace: string) => createTranslator({ locale: state.locale, messages: messages[state.locale] as never, namespace: namespace as never }),
    getFormatter: async () => ({ dateTime: () => "07:09" }),
    getLocale: async () => state.locale,
  };
});

import { CycleSummaryStrip } from "@/components/jobs/cycle-summary";
import { JobTicker } from "@/components/jobs/job-ticker";
import { readCycleSteps } from "@/lib/cycle/step-health";
import type { CycleSummary } from "@/lib/db/queries/today";

const NOW = new Date("2026-10-08T07:30:00Z");

const steps = readCycleSteps({
  steps: [
    { name: "collect", status: "ok" },
    { name: "pipeline", status: "failed" },
    { name: "filter", status: "failed" },
    { name: "ai", status: "failed" },
    { name: "notify", status: "partial" },
    { name: "maintenance", status: "failed" },
  ],
});

const summary: CycleSummary = {
  id: 9,
  kind: "weekday_morning",
  status: "partial",
  startedAt: NOW,
  finishedAt: NOW,
  channels: [],
  newCount: 0,
  mergedCount: null,
  fetched: 987,
  failedChannels: 0,
  passedCount: 0,
  qualifiedCount: 0,
  steps,
  unprocessed: 350,
};

function wrap(node: React.ReactNode, locale: "zh" | "en") {
  return (
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
      {node}
    </NextIntlClientProvider>
  );
}

describe("the ticker and the cycle card say the same thing", () => {
  for (const locale of ["zh", "en"] as const) {
    it(`${locale}: same state words, same step list (the push step included), no doubled 'failed'`, async () => {
      state.locale = locale;
      const ticker = render(wrap(await JobTicker({ summary, newJobs: [], timezone: "Europe/Berlin", maxItems: 10 }), locale));
      const tickerText = ticker.container.textContent ?? "";
      ticker.unmount();
      const card = render(wrap(await CycleSummaryStrip({ summary, next: null, timezone: "Europe/Berlin", now: NOW }), locale));
      const headline = card.getByTestId("cycle-summary").querySelector("#cycle-heading")?.textContent ?? "";
      const stateText = locale === "zh" ? "部分失败：处理 / 过滤 / 打分 / 维护 / 推送失败" : "partly failed: Process / Filter / Scoring / Maintenance / Push";
      expect(headline).toContain(stateText);
      expect(tickerText).toContain(stateText);
      if (locale === "en") expect(headline.match(/failed/g)).toHaveLength(1);
    });
  }

  it("the numbers: fetched vs still unprocessed, never 'fetched 350'", async () => {
    state.locale = "zh";
    const ticker = render(wrap(await JobTicker({ summary, newJobs: [], timezone: "Europe/Berlin", maxItems: 10 }), "zh"));
    expect(ticker.container.textContent).toContain("987 抓取 · 350 待处理");
  });
});

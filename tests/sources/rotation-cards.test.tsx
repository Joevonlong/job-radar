import { render, screen } from "@testing-library/react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const state = vi.hoisted(() => ({ locale: "en" as "en" | "zh" }));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: state.locale, messages: { en, zh }[state.locale] as never, namespace: namespace as never }),
  getFormatter: async () => ({ dateTime: () => "12:00", number: (value: number) => String(value) }),
  getLocale: async () => state.locale,
}));
vi.mock("@/app/control-actions", () => ({ runChannelNowAction: vi.fn(), testChannelAction: vi.fn(), testAiAction: vi.fn(), testTelegramAction: vi.fn() }));

import { CascadeCard } from "@/components/sources/cascade-card";
import { ChannelCard } from "@/components/sources/channel-card";
import type { RotationStatus } from "@/lib/sources/rotation-status";
import type { BackfillOptions } from "@/lib/sources/backfill";
import type { SourceCard } from "@/lib/sources/view";

const normal: RotationStatus = { sortChannel: "linkedin-guest", queries: 9, neverRun: 2, oldestWaitHours: 31,
  oldestWaiting: { id: "old", keywordGroup: "targets", location: "Berlin", remoteScope: null }, overCap: 0, maxCatchUpHours: 168 };

async function show(kind: "cascade" | "channel", rotation?: RotationStatus, locale: "en" | "zh" = "en", backfill?: BackfillOptions) {
  state.locale = locale;
  const card: SourceCard = {
    id: "indeed", family: "indeed", kind: "api", testable: true, registered: true, enabled: true, otherMarket: false,
    markets: [], notConfigured: false, missingEnv: [], login: null, circuit: null, lastSuccessAt: null,
    usage: { records: 0, usd: 0, budgetUsd: 0, freeRecords: 0, activity: { runs: 0, fetched: 0, newCount: 0 } },
    runs: [], latestCycleRuns: null, history: { fetched: [], outcomes: [], running: false, latest: null, skippedStreak: 0 }, status: "idle", skipped: null,
    ...(rotation ? { rotation } : {}),
  };
  const ui = kind === "channel"
    ? await ChannelCard({ card, timeZone: "UTC", healthCycles: 1, alertPercent: 80, ...(backfill ? { backfill } : {}) })
    : await CascadeCard({ cascade: { entries: [], servedBy: [], ...(rotation ? { rotation } : {}) }, hasCycle: false, alertPercent: 80, ...(backfill ? { backfill } : {}) });
  return render(<NextIntlClientProvider locale={locale} messages={{ en, zh }[locale]}>{ui}</NextIntlClientProvider>);
}

for (const kind of ["cascade", "channel"] as const) {
  describe(`${kind} rotation line`, () => {
    it("shows query count, longest wait and place, and never-run count", async () => {
      await show(kind, normal);
      const line = screen.getByTestId("rotation-status");
      expect(line).toHaveTextContent("9 queries · longest wait 31 h (targets · Berlin) · 2 never run");
      expect(line).toHaveAttribute("data-queries", "9");
      expect(line).toHaveAttribute("data-never-run", "2");
      expect(line).toHaveAttribute("data-over-cap", "0");
      expect(line).toHaveAttribute("data-sort-channel", "linkedin-guest");
      if (kind === "cascade") expect(line).toHaveTextContent("ordered by linkedin-guest");
      expect(screen.queryByTestId("rotation-warning")).not.toBeInTheDocument();
    });

    it("warns about lost coverage beyond the cap", async () => {
      await show(kind, { ...normal, overCap: 2 });
      expect(screen.getByTestId("rotation-status")).toHaveClass("text-warning-text");
      expect(screen.getByTestId("rotation-status")).toHaveAttribute("data-over-cap", "2");
      expect(screen.getByTestId("rotation-warning")).toHaveTextContent("2 queries waited longer than the catch-up limit (168 h): new jobs from that gap may have been missed. Raise the budget or use fewer queries.");
    });

    it("shows all queries never run without a zero-hour wait", async () => {
      await show(kind, { ...normal, oldestWaitHours: null, oldestWaiting: null, neverRun: 9 });
      const line = screen.getByTestId("rotation-status");
      expect(line).toHaveTextContent("9 never run");
      expect(line).not.toHaveTextContent("0 h");
      expect(line).not.toHaveTextContent("longest wait");
    });

    it("omits the line when no rotation was supplied", async () => {
      await show(kind);
      expect(screen.queryByTestId("rotation-status")).not.toBeInTheDocument();
    });

    it("renders Chinese and a labelled remote scope", async () => {
      await show(kind, { ...normal, overCap: 2, oldestWaiting: { id: "remote", keywordGroup: "targets", location: null, remoteScope: "worldwide" } }, "zh");
      const line = screen.getByTestId("rotation-status");
      expect(line).toHaveTextContent("查询 9 个 · 等得最久 31 小时（targets");
      expect(line).toHaveTextContent(zh.settings.options.remoteScope.worldwide);
      expect(line).toHaveTextContent("2 个从未运行");
      if (kind === "cascade") expect(line).toHaveTextContent("按 linkedin-guest 排序");
      expect(screen.getByTestId("rotation-warning")).toHaveTextContent("2 个查询等待超过补窗上限（168 小时）：这段时间的新岗位可能已错过。可以提高预算或减少查询。");
    });
  });
}

it.each(["en", "zh"] as const)("says no cascade channel can take queries now and omits wait claims in %s", async (locale) => {
  await show("cascade", { ...normal, sortChannel: null, neverRun: 0, oldestWaitHours: null, oldestWaiting: null }, locale);
  const line = screen.getByTestId("rotation-status");
  expect(line).toHaveTextContent(locale === "en" ? "no channel can take queries now" : "当前没有通道能接查询");
  expect(line).not.toHaveTextContent(locale === "en" ? "ordered by" : "排序");
  expect(line).not.toHaveTextContent(locale === "en" ? "longest wait" : "等得最久");
  expect(line).toHaveAttribute("data-sort-channel", "");
});

const backfillOptions: BackfillOptions = { maxHours: 72, cascade: false, channelIds: ["indeed"], local: { paidChannels: [], jsearch: false }, all: { paidChannels: ["linkedin-apify"], jsearch: true } };
for (const kind of ["cascade", "channel"] as const) {
  it(`${kind} keeps backfill available without rotation history`, async () => {
    await show(kind, undefined, "en", backfillOptions);
    expect(screen.getByRole("button", { name: "Backfill…" })).toBeVisible();
    expect(screen.queryByTestId("rotation-status")).not.toBeInTheDocument();
  });
  it(`${kind} links the over-cap hint to its own backfill control`, async () => {
    await show(kind, { ...normal, overCap: 2 }, "en", backfillOptions);
    const id = screen.getByRole("button", { name: "Backfill…" }).id;
    expect(screen.getByRole("link", { name: "Backfill this gap…" })).toHaveAttribute("href", `#${id}`);
  });
}

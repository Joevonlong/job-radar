import { render, screen } from "@testing-library/react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const state = vi.hoisted(() => ({ locale: "en" as "zh" | "en" }));

vi.mock("next-intl/server", () => {
  const messages = { zh, en } as const;
  return {
    getTranslations: async (namespace: string) => createTranslator({ locale: state.locale, messages: messages[state.locale] as never, namespace: namespace as never }),
    getFormatter: async () => ({ dateTime: () => "12:00", number: (n: number) => String(n) }),
  };
});
vi.mock("@/app/control-actions", () => ({ runChannelNowAction: vi.fn(), testChannelAction: vi.fn(), testAiAction: vi.fn(), testTelegramAction: vi.fn() }));

import { ChannelCard } from "@/components/sources/channel-card";
import type { RecentRun } from "@/lib/db/queries/sources";
import type { SourceCard } from "@/lib/sources/view";

const NOW = new Date("2026-10-12T07:00:00Z");

function run(id: number, extra: Partial<RecentRun>): RecentRun {
  return { id, cycleId: 1, startedAt: NOW, finishedAt: NOW, status: "succeeded", fetched: 20, newCount: 3, cost: 0, errorCode: null, error: null, interrupted: false, ...extra };
}

function card(runs: RecentRun[]): SourceCard {
  return {
    id: "stepstone",
    family: "stepstone",
    kind: "guest",
    testable: true,
    registered: true,
    enabled: true,
    otherMarket: false,
    markets: ["DE"],
    notConfigured: false,
    missingEnv: [],
    login: null,
    circuit: null,
    lastSuccessAt: null,
    usage: { records: 0, usd: 0, budgetUsd: 0, freeRecords: 0, activity: { runs: 0, fetched: 0, newCount: 0 } },
    runs,
    latestCycleRuns: null,
    history: { fetched: [], outcomes: [], running: false, latest: null, skippedStreak: 0 },
    skipped: null,
    status: "ok",
  } as SourceCard;
}

async function renderRuns(runs: RecentRun[], locale: "en" | "zh") {
  state.locale = locale;
  const ui = await ChannelCard({ card: card(runs), timeZone: "Europe/Berlin", healthCycles: 10, alertPercent: 80 });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const rowOf = (id: number): HTMLElement => {
  const row = screen.getByTestId("run-list").querySelector<HTMLElement>(`[data-run="${id}"]`);
  if (!row) throw new Error(`no run row ${id}`);
  return row;
};

describe("channel card: the last runs", () => {
  // both partial runs carry error code `parse`: only the marker tells them apart
  const interrupted = run(1, { status: "partial", errorCode: "parse", error: "interrupted after 20 postings: page 2 does not match", interrupted: true });
  const invalid = run(2, { status: "partial", errorCode: "parse", error: "2 of 20 records rejected (invalid shape)" });

  it.each([
    ["en", "interrupted: parse error"],
    ["zh", "中途中断：解析失败"],
  ] as const)("an interrupted partial shows a warning with its error; a partial with invalid records does not (%s)", async (locale, words) => {
    await renderRuns([interrupted, invalid], locale);
    const cut = rowOf(1);
    expect(cut).toHaveAttribute("data-status", "partial");
    expect(cut).toHaveAttribute("data-interrupted", "1");
    const warning = cut.querySelector("[data-testid='run-interrupted']");
    expect(warning).toHaveTextContent(words);
    expect(warning).toHaveClass("text-warning-text");
    expect(warning).toHaveAttribute("title", interrupted.error);
    // the counts of the kept postings still show
    expect(cut).toHaveTextContent("20");

    const rejected = rowOf(2);
    expect(rejected).toHaveAttribute("data-status", "partial");
    expect(rejected).not.toHaveAttribute("data-interrupted");
    expect(rejected.querySelector("[data-testid='run-interrupted']")).toBeNull();
  });

  it("a failed run still shows its error in red", async () => {
    await renderRuns([run(3, { status: "failed", errorCode: "blocked", error: "HTTP 403" })], "en");
    const failed = rowOf(3);
    expect(failed.querySelector("[data-testid='run-interrupted']")).toBeNull();
    expect(failed).toHaveTextContent("blocked by the site");
  });
});

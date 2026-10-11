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
import type { SourceCard } from "@/lib/sources/view";

function card(id: string): SourceCard {
  return {
    id,
    family: id,
    kind: "api",
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
    runs: [],
    latestCycleRuns: null,
    history: { fetched: [], outcomes: [], running: false, latest: null, skippedStreak: 0 },
    skipped: null,
    status: "ok",
  } as SourceCard;
}

async function renderCard(id: string, locale: "en" | "zh") {
  state.locale = locale;
  const ui = await ChannelCard({ card: card(id), timeZone: "Europe/Berlin", healthCycles: 10, alertPercent: 80 });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("channel card attribution", () => {
  it.each(["en", "zh"] as const)("the Arbeitnow card links back to arbeitnow.com (%s)", async (locale) => {
    await renderCard("arbeitnow", locale);
    const line = screen.getByTestId("channel-attribution");
    const link = line.querySelector("a");
    expect(link).toHaveAttribute("href", "https://www.arbeitnow.com");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveTextContent(/Arbeitnow/);
    expect(line).toHaveTextContent(locale === "en" ? /free public API/ : /免费公开接口/);
  });

  it("other channels have no attribution line", async () => {
    await renderCard("greenhouse", "en");
    expect(screen.queryByTestId("channel-attribution")).toBeNull();
  });
});

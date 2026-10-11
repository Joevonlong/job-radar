import { render, screen, within } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import zh from "../../messages/zh.json";

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: "zh", messages: zh as never, namespace: namespace as never }),
}));

import { PendingChannels } from "@/components/sources/pending-channels";
import type { SourceCard } from "@/lib/sources/view";

function card(id: string, extra: Partial<SourceCard> = {}): SourceCard {
  return {
    id,
    family: null,
    kind: null,
    testable: false,
    registered: false,
    enabled: true,
    otherMarket: false,
    markets: [],
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
    status: "not_registered",
    ...extra,
  };
}

describe("PendingChannels", () => {
  it("renders nothing without such channels", async () => {
    expect(await PendingChannels({ cards: [] })).toBeNull();
  });

  it("is one closed section with one compact row per channel, keeping the card hooks", async () => {
    render(
      await PendingChannels({
        cards: [card("tavily", { notConfigured: true, missingEnv: ["TAVILY_API_KEY"] }), card("linkedin-session", { enabled: false, login: { status: "missing" } as never }), card("ashby")],
      }),
    );
    const section = screen.getByTestId("pending-channels");
    expect(section.querySelector("details")).not.toHaveAttribute("open");
    expect(section).toHaveTextContent("尚未实现的通道（3）");
    const rows = within(section).getAllByTestId("channel-card");
    expect(rows.map((r) => r.getAttribute("data-channel"))).toEqual(["tavily", "linkedin-session", "ashby"]);
    expect(within(rows[0] as HTMLElement).getByTestId("not-configured")).toHaveTextContent("未配置");
    expect(within(rows[2] as HTMLElement).queryByTestId("not-configured")).toBeNull();
    expect(rows.every((r) => r.getAttribute("data-compact") === "1")).toBe(true);
    // no usage sections, no buttons: nothing runs
    expect(section.querySelector('[data-testid="run-list"]')).toBeNull();
    expect(within(section).queryByRole("button")).toBeNull();
  });
});

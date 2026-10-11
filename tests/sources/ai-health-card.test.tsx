import { render, screen, within } from "@testing-library/react";
import { createFormatter, createTranslator, NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const state = vi.hoisted(() => ({ locale: "zh" as "zh" | "en" }));

vi.mock("next-intl/server", () => {
  const messages = { zh, en } as const;
  return {
    getTranslations: async (namespace: string) => createTranslator({ locale: state.locale, messages: messages[state.locale] as never, namespace: namespace as never }),
    getFormatter: async () => createFormatter({ locale: state.locale, timeZone: "Europe/Berlin" }),
  };
});

// the Test button is a client component with its own tests; here only whether it is enabled matters
vi.mock("@/components/control/trigger-button", () => ({
  TriggerButton: ({ target, disabled }: { target: string; disabled?: boolean }) => <button data-testid={`test-${target}`} disabled={disabled} />,
}));

import { AiHealthCard } from "@/components/sources/ai-health-card";
import type { QuotaStatus } from "@/lib/ai/quota-guard";
import type { AiProviderId } from "@/lib/ai/types";
import { buildProviderViews } from "@/lib/sources/view";

import { shippedAi } from "../ai/helpers";

const NOW = new Date("2026-10-07T10:00:00Z");

const status = (provider: "codex-cli" | "claude-cli", over: Partial<QuotaStatus> = {}): [AiProviderId, QuotaStatus] => [
  provider,
  { provider, level: "ok", reason: null, resumeAt: null, windowRequests: 4, windowHours: 5, hardRequests: 10, cycleRequestCap: 5, notifiedLevel: null, ...over },
];

function providers(entries: Array<[AiProviderId, QuotaStatus]>) {
  return buildProviderViews({ now: NOW, aiConfig: shippedAi(), aiHealth: new Map(), aiQuota: new Map(entries), timeZone: "Europe/Berlin" });
}

function show(card: unknown) {
  render(
    <NextIntlClientProvider locale={state.locale} messages={state.locale === "zh" ? zh : en} timeZone="Europe/Berlin">
      {card as React.ReactElement}
    </NextIntlClientProvider>,
  );
}

async function renderCard(entries: Array<[AiProviderId, QuotaStatus]>, locale: "zh" | "en" = "zh") {
  state.locale = locale;
  show(await AiHealthCard({ providers: providers(entries), timeZone: "Europe/Berlin", alertPercent: 80 }));
}

const row = (id: string) => screen.getAllByTestId("ai-health-row").find((r) => r.dataset.provider === id) as HTMLElement;

describe("AI health card: Job Radar's usage cap", () => {
  it("shows a full window as guarded with the time it continues, and turns the Test button off", async () => {
    await renderCard([status("codex-cli", { level: "hard", reason: "window", windowRequests: 10, resumeAt: new Date("2026-10-07T12:30:00Z") }), status("claude-cli")]);
    const codex = row("codex-cli");
    expect(codex.dataset.state).toBe("guarded");
    expect(codex).toHaveTextContent("14:30");
    expect(within(codex).getByTestId("ai-quota-window")).toHaveAttribute("data-level", "hard");
    expect(within(codex).getByTestId("ai-quota-window")).toHaveTextContent("10");
    expect(within(codex).getByTestId("test-codex-cli")).toBeDisabled();
    expect(row("claude-cli").dataset.state).toBe("ready");
    expect(within(row("claude-cli")).getByTestId("test-claude-cli")).toBeEnabled();
  });

  it("notes that only Job Radar's own calls count, never speaking of a remaining quota", async () => {
    await renderCard([status("codex-cli"), status("claude-cli", { hardRequests: 0 })]);
    expect(screen.getByTestId("ai-quota-note").textContent).toBeTruthy();
    expect(screen.getByTestId("ai-health-card").textContent).not.toContain("剩余额度");
    expect(within(row("claude-cli")).getByTestId("ai-quota-window").querySelector("[role=meter], [role=progressbar]")).toBeNull();
  });

  it("has no window line and no note without the cap", async () => {
    state.locale = "en";
    show(await AiHealthCard({ providers: buildProviderViews({ now: NOW, aiConfig: shippedAi(), aiHealth: new Map(), timeZone: "UTC" }), timeZone: "UTC", alertPercent: 80 }));
    expect(screen.queryByTestId("ai-quota-window")).toBeNull();
    expect(screen.queryByTestId("ai-quota-note")).toBeNull();
  });
});

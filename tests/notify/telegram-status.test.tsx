import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { TelegramStatus } from "@/components/notify/telegram-status";
import { loadTelegramStatus, telegramSetupState, type TelegramStatusView } from "@/lib/notify/telegram-status";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

vi.mock("@/app/control-actions", () => ({ runChannelNowAction: vi.fn(), testChannelAction: vi.fn(), testAiAction: vi.fn(), testTelegramAction: vi.fn() }));

const TOKEN = "123456:FAKE-status-secret-token";
const CHAT = "-1009876543210";

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh} timeZone="UTC">
    {node}
  </NextIntlClientProvider>
);

async function statusFor(env: Record<string, string>, enabled: boolean | null = true): Promise<TelegramStatusView> {
  return loadTelegramStatus({ enabled, db: null, env });
}

describe("telegramSetupState", () => {
  it("tells missing, partial, invalid and configured apart", () => {
    expect(telegramSetupState({})).toBe("missing");
    expect(telegramSetupState({ TELEGRAM_BOT_TOKEN: TOKEN })).toBe("partial");
    expect(telegramSetupState({ TELEGRAM_CHAT_ID: CHAT })).toBe("partial");
    expect(telegramSetupState({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "not-a-number" })).toBe("invalid");
    expect(telegramSetupState({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT })).toBe("configured");
  });

  it("the status view carries names and booleans, never a value", async () => {
    const view = await statusFor({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT, TELEGRAM_ALLOWED_USER_IDS: "42424242" });
    const json = JSON.stringify(view);
    for (const secret of [TOKEN, CHAT, "42424242"]) expect(json).not.toContain(secret);
    expect(view.env).toEqual([
      { name: "TELEGRAM_BOT_TOKEN", present: true },
      { name: "TELEGRAM_CHAT_ID", present: true },
      { name: "TELEGRAM_ALLOWED_USER_IDS", present: true },
    ]);
    expect(view.lastTest).toBeNull();
  });
});

describe("TelegramStatus", () => {
  it("not set up: shows the guide with the command and no test button", async () => {
    const { container } = render(wrap(<TelegramStatus status={await statusFor({})} />));
    expect(screen.getByTestId("telegram-status")).toHaveAttribute("data-state", "missing");
    expect(screen.getByTestId("telegram-guide")).toBeInTheDocument();
    expect(screen.getByTestId("telegram-setup-command")).toHaveTextContent("pnpm run setup --step telegram");
    expect(screen.queryByRole("button", { name: /test/i })).toBeNull();
    expect(container.querySelector("a[href*='telegram']")).not.toBeNull();
  });

  it("half set up: says which problem, still guides", async () => {
    const { container } = render(wrap(<TelegramStatus status={await statusFor({ TELEGRAM_BOT_TOKEN: TOKEN })} />));
    expect(screen.getByTestId("telegram-status")).toHaveAttribute("data-state", "partial");
    expect(screen.getByRole("status")).toHaveTextContent(en.settings.telegramStatus.problem.partial);
    expect(container.textContent).not.toContain(TOKEN);
  });

  it("set up: connected, the test button and the change hint; no value on the page", async () => {
    const status = await statusFor({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT }, false);
    const { container } = render(wrap(<TelegramStatus status={{ ...status, lastTest: { ok: false, at: "2026-10-10T08:00:00.000Z", error: "telegram_not_configured" } }} />, "zh"));
    expect(screen.getByTestId("telegram-status-badge")).toHaveTextContent(zh.settings.telegramStatus.state.configured);
    expect(screen.queryByTestId("telegram-guide")).toBeNull();
    expect(screen.getByTestId("telegram-status-enabled")).toHaveTextContent(zh.settings.telegramStatus.enabledOff);
    expect(screen.getByTestId("telegram-status-last-test")).toHaveTextContent(zh.settings.telegramStatus.testErrors.telegram_not_configured);
    expect(screen.getByTestId("telegram-setup-command")).toBeInTheDocument();
    for (const secret of [TOKEN, CHAT]) expect(container.innerHTML).not.toContain(secret);
  });
});

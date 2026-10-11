// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createLogger, type LogRecord } from "@/lib/channels/logger";
import { createTelegramRuntime } from "@/lib/notify/runtime";

import { notifyConfig } from "./helpers";

const ENV = { TELEGRAM_BOT_TOKEN: "123456:test-token-not-real", TELEGRAM_CHAT_ID: "555" };

function setup(baseUrl: string, env: Record<string, string>) {
  const logs: LogRecord[] = [];
  const urls: string[] = [];
  const runtime = createTelegramRuntime({
    config: notifyConfig((c) => Object.assign(c.telegram, { enabled: true, api_base_url: baseUrl, max_retries: 0 })),
    logger: createLogger({ sink: (r) => logs.push(r), minLevel: "debug" }),
    env,
    fetch: async (url) => {
      urls.push(url);
      return { status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 555 }, date: 0 } }) };
    },
  });
  return { runtime, logs, urls };
}

describe("telegram runtime: the bot token goes only to the Bot API host", () => {
  it("the default host is used as configured", () => {
    expect(setup("https://api.telegram.org", ENV).runtime).not.toBeNull();
  });

  it("a changed api_base_url disables Telegram without the opt-in (and never logs the token)", () => {
    const { runtime, logs, urls } = setup("https://tg.evil.example", ENV);
    expect(runtime).toBeNull();
    expect(urls).toEqual([]);
    expect(logs.some((l) => l.level === "error" && JSON.stringify(l.fields).includes("JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1"))).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("test-token-not-real");
  });

  it("with JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1 it is used, with a warning", async () => {
    const { runtime, logs, urls } = setup("https://tg-proxy.example", { ...ENV, JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS: "1" });
    expect(runtime).not.toBeNull();
    await runtime?.client.sendMessage({ chatId: runtime.chatId, text: "hi" });
    expect(urls[0]).toMatch(/^https:\/\/tg-proxy\.example\/bot/);
    expect(logs.some((l) => l.level === "warn" && l.message === "telegram uses a custom api_base_url")).toBe(true);
  });
});

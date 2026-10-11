import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "@/lib/channels/logger";
import { createTelegramClient, isTelegramError, TelegramError, type TelegramClient, type TelegramFetch } from "@/lib/notify/telegram-client";

import { FakeBotApi, FAKE_TOKEN } from "./fake-bot-api";

const api = new FakeBotApi();
beforeAll(() => api.start());
afterAll(() => api.stop());
beforeEach(() => api.reset());

const sleeps: number[] = [];
const sleep = async (ms: number): Promise<void> => {
  sleeps.push(ms);
};
beforeEach(() => {
  sleeps.length = 0;
});

function client(overrides: Partial<Parameters<typeof createTelegramClient>[0]> = {}): TelegramClient {
  return createTelegramClient({ token: FAKE_TOKEN, baseUrl: api.url, requestTimeoutMs: 30_000, maxRetries: 2, sleep, ...overrides });
}

async function failure(promise: Promise<unknown>): Promise<TelegramError> {
  try {
    await promise;
  } catch (error) {
    if (isTelegramError(error)) return error;
    throw error;
  }
  throw new Error("expected a TelegramError");
}

describe("requests", () => {
  it("sends HTML messages with the keyboard and without link previews, and returns the message id", async () => {
    const keyboard = { inline_keyboard: [[{ text: "x", callback_data: "a:1:i" }]] };
    const result = await client().sendMessage({ chatId: "555", text: "<b>hi</b>", keyboard });
    expect(result).toEqual({ messageId: 100 });
    expect(api.of("sendMessage")[0]?.body).toEqual({
      chat_id: "555",
      text: "<b>hi</b>",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard,
    });
  });

  it("edits a message, answers a callback and reads the bot identity", async () => {
    const c = client();
    await c.editMessageText({ chatId: "555", messageId: 9, text: "t", keyboard: { inline_keyboard: [] } });
    await c.answerCallbackQuery({ callbackQueryId: "q1", text: "ok" });
    expect(await c.getMe()).toEqual({ id: 42, username: "job_radar_test_bot" });
    expect(api.of("editMessageText")[0]?.body).toMatchObject({ chat_id: "555", message_id: 9, reply_markup: { inline_keyboard: [] } });
    expect(api.of("answerCallbackQuery")[0]?.body).toEqual({ callback_query_id: "q1", text: "ok" });
  });

  it("tolerates a base URL with a trailing slash", async () => {
    await client({ baseUrl: `${api.url}/` }).getMe();
    expect(api.of("getMe")).toHaveLength(1);
  });
});

describe("getUpdates", () => {
  it("returns updates, the highest update id and counts malformed ones", async () => {
    api.pushUpdate({ update_id: 10, callback_query: { id: "q", from: { id: 1 }, message: { message_id: 5, chat: { id: 555 } }, data: "a:1:i" } });
    api.pushUpdate({ update_id: 11, message: { message_id: 6, chat: { id: 555 }, text: "hi" } });
    api.pushUpdate({ update_id: 12, message: { message_id: "bad" } } as never);
    const result = await client().getUpdates({ offset: 10, timeoutSeconds: 1 });
    expect(result.updates.map((u) => u.update_id)).toEqual([10, 11]);
    expect(result.lastUpdateId).toBe(12);
    expect(result.malformed).toBe(1);
    expect(api.of("getUpdates")[0]?.body).toEqual({ offset: 10, timeout: 1, allowed_updates: ["message", "callback_query"] });
  });

  it("long-polls: an update arriving while it waits is delivered at once", async () => {
    const pending = client().getUpdates({ timeoutSeconds: 2 });
    await api.whenPollWaiting();
    api.pushUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 1 } } });
    expect((await pending).updates).toHaveLength(1);
  });

  it("returns an empty batch with no lastUpdateId", async () => {
    expect(await client().getUpdates({ timeoutSeconds: 0 })).toEqual({ updates: [], lastUpdateId: null, malformed: 0 });
  });

  it("is cancelled by its signal", async () => {
    const controller = new AbortController();
    const pending = client().getUpdates({ timeoutSeconds: 2, signal: controller.signal });
    await api.whenPollWaiting();
    controller.abort();
    expect((await failure(pending)).kind).toBe("aborted");
  });

  it("is never retried inside the client", async () => {
    api.failNext("getUpdates", 500, { ok: false, error_code: 500, description: "boom" }, 5);
    await failure(client().getUpdates({ timeoutSeconds: 0 }));
    expect(api.of("getUpdates")).toHaveLength(1);
  });
});

describe("failures", () => {
  it("surfaces an API error with its description and code", async () => {
    api.failNext("sendMessage", 400, { ok: false, error_code: 400, description: "Bad Request: chat not found" });
    const error = await failure(client().sendMessage({ chatId: "1", text: "x" }));
    expect(error).toMatchObject({ kind: "api", status: 400, errorCode: 400, description: "Bad Request: chat not found", retryable: false });
    expect(api.of("sendMessage")).toHaveLength(1);
  });

  it("retries a 429 after the time Telegram asks for, then succeeds", async () => {
    api.failNext("sendMessage", 429, { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } });
    const result = await client().sendMessage({ chatId: "1", text: "x" });
    expect(result.messageId).toBe(100);
    expect(sleeps).toEqual([3000]);
    expect(api.of("sendMessage")).toHaveLength(2);
  });

  it("gives up when 429 asks for a very long wait", async () => {
    api.failNext("sendMessage", 429, { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3600 } });
    const error = await failure(client().sendMessage({ chatId: "1", text: "x" }));
    expect(error.retryAfterSeconds).toBe(3600);
    expect(sleeps).toEqual([]);
  });

  it("retries 5xx with growing waits up to maxRetries, then fails", async () => {
    api.failNext("sendMessage", 502, "<html>bad gateway</html>", 5);
    const error = await failure(client().sendMessage({ chatId: "1", text: "x" }));
    expect(error).toMatchObject({ kind: "api", status: 502, retryable: true });
    expect(api.of("sendMessage")).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it("classifies a connection failure as network and never leaks the token", async () => {
    const down: TelegramFetch = async (url) => {
      throw new TypeError(`fetch failed for ${url}`);
    };
    const error = await failure(client({ fetch: down, maxRetries: 0 }).sendMessage({ chatId: "1", text: "x" }));
    expect(error.kind).toBe("network");
    expect(error.message).not.toContain(FAKE_TOKEN);
    expect(error.message).toContain("[token]");
  });

  it("scrubs the token from API descriptions too", async () => {
    api.failNext("sendMessage", 400, { ok: false, error_code: 400, description: `bad request for bot${FAKE_TOKEN}` });
    expect((await failure(client().sendMessage({ chatId: "1", text: "x" }))).message).not.toContain(FAKE_TOKEN);
  });

  it("times out when the server does not answer", async () => {
    const hang: TelegramFetch = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const error = await failure(client({ fetch: hang, requestTimeoutMs: 20, maxRetries: 0 }).sendMessage({ chatId: "1", text: "x" }));
    expect(error.kind).toBe("timeout");
  });

  it("rejects an answer that is not a Bot API response", async () => {
    const odd: TelegramFetch = async () => ({ status: 200, text: async () => JSON.stringify({ hello: "world" }) });
    expect((await failure(client({ fetch: odd }).getMe())).kind).toBe("parse");
    const wrongShape: TelegramFetch = async () => ({ status: 200, text: async () => JSON.stringify({ ok: true, result: { nope: 1 } }) });
    expect((await failure(client({ fetch: wrongShape }).sendMessage({ chatId: "1", text: "x" }))).kind).toBe("parse");
  });

  it("does not retry an unknown bot (wrong token)", async () => {
    const error = await failure(client({ token: "999:wrong" }).getMe());
    expect(error).toMatchObject({ kind: "api", status: 404 });
    expect(api.calls).toEqual([]);
  });

  it("logs a retry without the token", async () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (r) => lines.push(JSON.stringify(r)), minLevel: "debug" });
    api.failNext("sendMessage", 503);
    await client({ logger }).sendMessage({ chatId: "1", text: "x" });
    expect(lines.join("\n")).toContain("will be retried");
    expect(lines.join("\n")).not.toContain(FAKE_TOKEN);
  });
});

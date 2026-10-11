import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import type { ChannelLogger } from "@/lib/channels/types";

/**
 * Minimal Telegram Bot API client over plain `fetch`: `sendMessage`,
 * `editMessageText`, `answerCallbackQuery`, `getUpdates`. Responses are validated with zod (C6).
 * The token is part of every URL, so it is scrubbed from every error and log line (C4).
 */

export type TelegramErrorKind = "api" | "network" | "timeout" | "aborted" | "parse";

export class TelegramError extends Error {
  readonly kind: TelegramErrorKind;
  readonly method: string;
  /** HTTP status, when the server answered. */
  readonly status: number | null;
  /** Bot API `error_code`, when the body carried one. */
  readonly errorCode: number | null;
  /** Seconds the server asks to wait (429), when given. */
  readonly retryAfterSeconds: number | null;
  /** The Bot API `description`, e.g. "Bad Request: message is not modified". */
  readonly description: string;

  constructor(
    kind: TelegramErrorKind,
    method: string,
    description: string,
    extra: { status?: number | null; errorCode?: number | null; retryAfterSeconds?: number | null } = {},
  ) {
    super(`telegram ${method} failed (${kind}${extra.status ? ` ${extra.status}` : ""}): ${description}`);
    this.name = "TelegramError";
    this.kind = kind;
    this.method = method;
    this.description = description;
    this.status = extra.status ?? null;
    this.errorCode = extra.errorCode ?? null;
    this.retryAfterSeconds = extra.retryAfterSeconds ?? null;
  }

  /** A retry may help: network trouble, timeouts, 429, 5xx. */
  get retryable(): boolean {
    if (this.kind === "network" || this.kind === "timeout") return true;
    return this.kind === "api" && (this.status === 429 || (this.status !== null && this.status >= 500));
  }
}

export function isTelegramError(error: unknown): error is TelegramError {
  return error instanceof TelegramError;
}

// ---------------------------------------------------------------- wire schemas

const responseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().optional(),
  description: z.string().optional(),
  parameters: z.object({ retry_after: z.number().optional() }).optional(),
});

const sentMessageSchema = z.object({ message_id: z.number().int() });

/** Names are optional and only read by `pnpm run setup` to say which chat sent the first message. */
const chatSchema = z.object({ id: z.number(), type: z.string().optional(), title: z.string().optional(), first_name: z.string().optional(), last_name: z.string().optional(), username: z.string().optional() });

const senderSchema = z.object({ id: z.number(), is_bot: z.boolean().optional(), first_name: z.string().optional(), last_name: z.string().optional(), username: z.string().optional() });

const updateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({ message_id: z.number().int(), date: z.number().int().optional(), chat: chatSchema, from: senderSchema.optional(), text: z.string().optional() })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: z.object({ id: z.number() }),
      message: z.object({ message_id: z.number().int(), chat: chatSchema }).optional(),
      data: z.string().optional(),
    })
    .optional(),
});

export type TelegramUpdate = z.infer<typeof updateSchema>;

const meSchema = z.object({ id: z.number(), username: z.string().optional() });

// ---------------------------------------------------------------- public types

export interface InlineButton {
  text: string;
  callback_data: string;
}
export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}

export interface SendMessageInput {
  chatId: string;
  /** HTML (see `format.ts`). */
  text: string;
  keyboard?: InlineKeyboard;
}

export interface EditMessageInput {
  chatId: string;
  messageId: number;
  text: string;
  /** `{ inline_keyboard: [] }` removes the buttons; omitted keeps them. */
  keyboard?: InlineKeyboard;
}

export interface GetUpdatesResult {
  updates: TelegramUpdate[];
  /** Highest `update_id` of the batch (valid or not): the next offset is this + 1. null for an empty batch. */
  lastUpdateId: number | null;
  /** Updates that did not match the expected shape (skipped, logged). */
  malformed: number;
}

export interface TelegramClient {
  sendMessage(input: SendMessageInput): Promise<{ messageId: number }>;
  editMessageText(input: EditMessageInput): Promise<void>;
  answerCallbackQuery(input: { callbackQueryId: string; text?: string }): Promise<void>;
  getUpdates(input: { offset?: number; timeoutSeconds: number; signal?: AbortSignal }): Promise<GetUpdatesResult>;
  getMe(): Promise<{ id: number; username: string | null }>;
}

export type TelegramFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: "error" }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface TelegramClientOptions {
  token: string;
  /** Bot API root, e.g. `https://api.telegram.org` (config: `telegram.api_base_url`). */
  baseUrl: string;
  /** Per-request timeout; `getUpdates` adds its poll timeout on top. */
  requestTimeoutMs: number;
  /** Retries after a 429 / 5xx / network error (not used by `getUpdates`: the poller backs off itself). */
  maxRetries: number;
  logger?: ChannelLogger;
  fetch?: TelegramFetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Longest wait honoured for a 429 `retry_after`; a longer one fails the call. */
  maxRetryAfterMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;
const RETRY_BASE_MS = 500;

const defaultFetch: TelegramFetch = (url, init) => fetch(url, init);
const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> => delay(ms, undefined, signal ? { signal } : undefined);

export function createTelegramClient(options: TelegramClientOptions): TelegramClient {
  const doFetch = options.fetch ?? defaultFetch;
  const sleep = options.sleep ?? defaultSleep;
  const base = options.baseUrl.replace(/\/+$/, "");
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;

  /** Remove the token (and its URL form) from any text that may reach a log or an error. */
  const scrub = (text: string): string => (options.token.length > 0 ? text.split(options.token).join("[token]") : text);

  async function once(method: string, payload: unknown, timeoutMs: number, signal: AbortSignal | undefined): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signals = [timeout, ...(options.signal ? [options.signal] : []), ...(signal ? [signal] : [])];
    const combined = AbortSignal.any(signals);
    let status: number;
    let body: string;
    try {
      const response = await doFetch(`${base}/bot${options.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: combined,
        // the token is in the URL: never follow a redirect with it
        redirect: "error",
      });
      status = response.status;
      body = await response.text();
    } catch (error) {
      if (timeout.aborted) throw new TelegramError("timeout", method, `no answer within ${timeoutMs} ms`);
      if (combined.aborted) throw new TelegramError("aborted", method, "cancelled");
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
      const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
      throw new TelegramError("network", method, scrub(`${reason}${cause}`).slice(0, 300));
    }

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      // e.g. an HTML 502 page from a proxy
      throw new TelegramError(status >= 500 ? "api" : "parse", method, `answer is not JSON (HTTP ${status})`, { status });
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) throw new TelegramError(status >= 500 ? "api" : "parse", method, `answer does not look like a Bot API response (HTTP ${status})`, { status });
    if (!parsed.data.ok) {
      throw new TelegramError("api", method, scrub(parsed.data.description ?? "unknown error").slice(0, 300), {
        status,
        errorCode: parsed.data.error_code ?? null,
        retryAfterSeconds: parsed.data.parameters?.retry_after ?? null,
      });
    }
    return parsed.data.result;
  }

  async function call<S extends z.ZodType>(
    method: string,
    payload: unknown,
    schema: S,
    opts: { retries?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<z.infer<S>> {
    const retries = opts.retries ?? options.maxRetries;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await once(method, payload, opts.timeoutMs ?? options.requestTimeoutMs, opts.signal);
        const parsed = schema.safeParse(result);
        if (!parsed.success) throw new TelegramError("parse", method, "result has an unexpected shape");
        return parsed.data;
      } catch (error) {
        if (!(error instanceof TelegramError) || !error.retryable || attempt >= retries) throw error;
        const waitMs = error.retryAfterSeconds !== null ? error.retryAfterSeconds * 1000 : RETRY_BASE_MS * 2 ** attempt;
        if (waitMs > maxRetryAfterMs) throw error;
        options.logger?.warn("telegram request will be retried", { method, attempt: attempt + 1, waitMs, kind: error.kind, status: error.status });
        await sleep(waitMs, options.signal);
      }
    }
  }

  return {
    async sendMessage(input) {
      const result = await call("sendMessage", {
        chat_id: input.chatId,
        text: input.text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(input.keyboard ? { reply_markup: input.keyboard } : {}),
      }, sentMessageSchema);
      return { messageId: result.message_id };
    },
    async editMessageText(input) {
      await call("editMessageText", {
        chat_id: input.chatId,
        message_id: input.messageId,
        text: input.text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(input.keyboard ? { reply_markup: input.keyboard } : {}),
      }, z.unknown());
    },
    async answerCallbackQuery(input) {
      await call("answerCallbackQuery", { callback_query_id: input.callbackQueryId, ...(input.text ? { text: input.text } : {}) }, z.unknown());
    },
    async getUpdates(input) {
      const raw = await call(
        "getUpdates",
        { ...(input.offset === undefined ? {} : { offset: input.offset }), timeout: input.timeoutSeconds, allowed_updates: ["message", "callback_query"] },
        z.array(z.unknown()),
        { retries: 0, timeoutMs: options.requestTimeoutMs + input.timeoutSeconds * 1000, ...(input.signal ? { signal: input.signal } : {}) },
      );
      const updates: TelegramUpdate[] = [];
      let lastUpdateId: number | null = null;
      let malformed = 0;
      for (const item of raw) {
        const id = z.object({ update_id: z.number().int() }).safeParse(item);
        if (id.success) lastUpdateId = Math.max(lastUpdateId ?? id.data.update_id, id.data.update_id);
        const update = updateSchema.safeParse(item);
        if (update.success) updates.push(update.data);
        else malformed += 1;
      }
      return { updates, lastUpdateId, malformed };
    },
    async getMe() {
      const me = await call("getMe", {}, meSchema);
      return { id: me.id, username: me.username ?? null };
    },
  };
}

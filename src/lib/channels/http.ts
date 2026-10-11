import type { z } from "zod";

import { ChannelError, errorFromHttp, isAbortError } from "./errors";
import { safeUrl, silentLogger } from "./logger";
import type { ChannelLogger, HttpClient, HttpRequestInit, HttpResponse } from "./types";

export type FetchLike = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal: AbortSignal; redirect?: "error" | "follow" | "manual" },
) => Promise<HttpResponse>;

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface HttpSettings {
  timeoutMs: number;
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export interface HttpClientOptions {
  settings: HttpSettings;
  /** The cycle's signal: aborting it cancels in-flight requests and pending backoff sleeps. */
  signal?: AbortSignal;
  fetch?: FetchLike;
  logger?: ChannelLogger;
  sleep?: SleepFn;
  /** [0, 1) — injected so backoff jitter is testable. */
  random?: () => number;
  now?: () => Date;
}

/** Longest part of a non-OK response read to detect verification pages. */
const ERROR_BODY_EXCERPT_CHARS = 2000;

/** Abortable sleep on setTimeout (so fake timers drive it in tests). */
export const defaultSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date. null when absent or unparsable. */
export function parseRetryAfter(value: string | null, now: Date): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now.getTime());
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

/**
 * At most `maxBytes` of a body as UTF-8 text. A stream is read chunk by chunk and cancelled at the limit (the rest is never
 * downloaded); a response without one (a fake) is read whole and cut. A character split at the limit is dropped.
 */
export async function readTextUpTo(response: HttpResponse, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    const bytes = new TextEncoder().encode(text);
    if (bytes.length <= maxBytes) return { text, truncated: false };
    return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, maxBytes)).replace(/\uFFFD$/u, ""), truncated: true };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  let read = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - read;
      if (value.length > room) {
        text += decoder.decode(value.slice(0, room), { stream: true });
        truncated = true;
        break;
      }
      read += value.length;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }
  return { text: truncated ? text : text + decoder.decode(), truncated };
}

/**
 * `fetch` with a per-request timeout and retries: network errors, timeouts, 5xx and 429 are retried
 * with exponential backoff and jitter, honouring Retry-After (a wait longer than `backoffMaxMs` is
 * not worth sleeping through: the error is raised immediately). Everything else becomes a
 * classified `ChannelError` (see errors.ts). Logs host + path only, never headers or queries (C4).
 */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  const { settings } = options;
  const doFetch = options.fetch ?? defaultFetch;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? silentLogger;

  function backoffDelay(retryIndex: number): number {
    const exponential = Math.min(settings.backoffMaxMs, settings.backoffBaseMs * 2 ** retryIndex);
    // "Equal jitter": between half and the full exponential delay.
    return Math.round(exponential * (0.5 + random() * 0.5));
  }

  async function attemptOnce(url: string, init: HttpRequestInit): Promise<HttpResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutMs = init.timeoutMs ?? settings.timeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    // Never keep the process alive just for a request timeout.
    (timer as { unref?: () => void }).unref?.();

    const outer = [options.signal, init.signal].filter((s): s is AbortSignal => s !== undefined);
    const onOuterAbort = (): void => controller.abort();
    for (const signal of outer) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    const cleanup = (): void => {
      clearTimeout(timer);
      for (const signal of outer) signal.removeEventListener("abort", onOuterAbort);
    };

    try {
      const response = await doFetch(url, {
        ...(init.method === undefined ? {} : { method: init.method }),
        ...(init.headers === undefined ? {} : { headers: init.headers }),
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.redirect === undefined ? {} : { redirect: init.redirect }),
        signal: controller.signal,
      });
      // Keep the timeout armed until the body has been read. A timeout, a cut connection or a cancellation while the body streams
      // in is turned into the same errors as during the request (a slow body must not escape as a bare AbortError).
      const bodyError = (error: unknown, reading: "text" | "json"): unknown => {
        const cancelled = outer.find((s) => s.aborted);
        if (cancelled) return abortReason(cancelled);
        if (timedOut || isAbortError(error)) return new ChannelError("network", `reading the response of ${safeUrl(url)} timed out after ${timeoutMs} ms`, { cause: error });
        // a JSON syntax error stays what it is (the caller reports it as a parse error)
        if (reading === "json" && error instanceof SyntaxError) return error;
        if (error instanceof ChannelError) return error;
        return new ChannelError("network", `reading the response of ${safeUrl(url)} failed`, { cause: error });
      };
      const read = async <T>(reading: "text" | "json", body: () => Promise<T>): Promise<T> => {
        try {
          return await body();
        } catch (error) {
          throw bodyError(error, reading);
        } finally {
          cleanup();
        }
      };
      return {
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        text: () => read("text", () => response.text()),
        json: () => read("json", () => response.json()),
        textUpTo: (maxBytes: number) => read("text", () => readTextUpTo(response, maxBytes)),
      };
    } catch (error) {
      cleanup();
      const cancelled = outer.find((s) => s.aborted);
      if (cancelled) throw abortReason(cancelled);
      if (timedOut || isAbortError(error)) {
        throw new ChannelError("network", `request to ${safeUrl(url)} timed out after ${timeoutMs} ms`, { cause: error });
      }
      throw new ChannelError("network", `request to ${safeUrl(url)} failed`, { cause: error });
    }
  }

  async function request(url: string, init: HttpRequestInit = {}): Promise<HttpResponse> {
    const maxRetries = init.maxRetries ?? settings.maxRetries;
    const where = new URL(url).host;
    for (let attempt = 0; ; attempt += 1) {
      options.signal?.throwIfAborted();
      let failure: ChannelError;
      try {
        const response = await attemptOnce(url, init);
        if (response.status < 400 || init.allowStatus?.includes(response.status)) return response;
        let excerpt = "";
        try {
          excerpt = (await response.text()).slice(0, ERROR_BODY_EXCERPT_CHARS);
        } catch {
          // body unreadable: classify by status alone
        }
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now());
        failure =
          errorFromHttp(response.status, {
            where,
            bodyExcerpt: excerpt,
            ...(retryAfterMs === null ? {} : { retryAfterMs }),
          }) ?? new ChannelError("unknown", `HTTP ${response.status} from ${where}`);
      } catch (error) {
        if (!(error instanceof ChannelError)) throw error; // abort
        failure = error;
      }

      if (!failure.retryable || attempt >= maxRetries) throw failure;
      let delayMs = backoffDelay(attempt);
      if (failure.retryAfterMs !== undefined) {
        if (failure.retryAfterMs > settings.backoffMaxMs) {
          logger.warn("retry-after too long, giving up", { host: where, retryAfterMs: failure.retryAfterMs });
          throw failure;
        }
        delayMs = Math.max(delayMs, failure.retryAfterMs);
      }
      logger.debug("retrying request", { host: where, path: new URL(url).pathname, code: failure.code, status: failure.status, attempt: attempt + 1, delayMs });
      await sleep(delayMs, options.signal);
    }
  }

  async function json<S extends z.ZodType>(url: string, schema: S, init?: HttpRequestInit): Promise<z.infer<S>> {
    const response = await request(url, init);
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      // a timeout or a cut connection while reading the body is a network error, a cancellation stays one
      if (error instanceof ChannelError || isAbortError(error) || init?.signal?.aborted || options.signal?.aborted) throw error;
      throw new ChannelError("parse", `response from ${new URL(url).host} is not valid JSON`, { cause: error });
    }
    const result = schema.safeParse(body);
    if (!result.success) {
      const paths = result.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(root)");
      throw new ChannelError("parse", `response from ${new URL(url).host} does not match the expected shape (${paths.join(", ")})`);
    }
    return result.data;
  }

  return { request, json };
}

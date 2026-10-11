// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ChannelError } from "@/lib/channels/errors";
import { createHttpClient, parseRetryAfter, type FetchLike, type HttpSettings } from "@/lib/channels/http";
import { createLogger, type LogRecord } from "@/lib/channels/logger";
import type { HttpResponse } from "@/lib/channels/types";

const SETTINGS: HttpSettings = { timeoutMs: 5000, maxRetries: 3, backoffBaseMs: 1000, backoffMaxMs: 30000 };
const URL_OK = "https://api.example.test/jobs?token=sekret";

function response(status: number, body = "", headers: Record<string, string> = {}): HttpResponse {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  };
}

/** A fetch that answers with the given steps in order (the last one repeats). */
function scripted(...steps: Array<HttpResponse | Error>): { fetch: FetchLike; calls: () => number } {
  let n = 0;
  return {
    fetch: async () => {
      const step = steps[Math.min(n, steps.length - 1)];
      n += 1;
      if (step instanceof Error) throw step;
      if (!step) throw new Error("no step");
      return step;
    },
    calls: () => n,
  };
}

function client(fetch: FetchLike, overrides: Partial<HttpSettings> = {}, extra: { random?: () => number; signal?: AbortSignal } = {}) {
  const sleeps: number[] = [];
  const http = createHttpClient({
    settings: { ...SETTINGS, ...overrides },
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: extra.random ?? (() => 1),
    ...(extra.signal ? { signal: extra.signal } : {}),
  });
  return { http, sleeps };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("retries", () => {
  it("retries 5xx and network errors with exponential backoff, then succeeds", async () => {
    const { fetch, calls } = scripted(response(503), new TypeError("fetch failed"), response(502), response(200, "{}"));
    const { http, sleeps } = client(fetch);
    const res = await http.request(URL_OK);
    expect(res.status).toBe(200);
    expect(calls()).toBe(4);
    // random() = 1 -> the full exponential delay: 1s, 2s, 4s
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it("applies jitter between half and the full delay and caps at backoff_max_ms", async () => {
    const { fetch } = scripted(response(500), response(500), response(500), response(200));
    const { http, sleeps } = client(fetch, { backoffMaxMs: 3000 }, { random: () => 0 });
    await http.request(URL_OK);
    expect(sleeps).toEqual([500, 1000, 1500]);
  });

  it("gives up after max_retries and raises the last classified error", async () => {
    const { fetch, calls } = scripted(response(503));
    const { http, sleeps } = client(fetch, { maxRetries: 2 });
    await expect(http.request(URL_OK)).rejects.toMatchObject({ code: "network", status: 503, retryable: true });
    expect(calls()).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it("does not retry when max_retries is 0 or overridden per request", async () => {
    const a = scripted(response(503));
    await expect(client(a.fetch, { maxRetries: 0 }).http.request(URL_OK)).rejects.toBeInstanceOf(ChannelError);
    expect(a.calls()).toBe(1);
    const b = scripted(response(503));
    await expect(client(b.fetch).http.request(URL_OK, { maxRetries: 0 })).rejects.toBeInstanceOf(ChannelError);
    expect(b.calls()).toBe(1);
  });

  it("honours Retry-After (seconds) when it is longer than the backoff", async () => {
    const { fetch } = scripted(response(429, "", { "Retry-After": "7" }), response(200));
    const { http, sleeps } = client(fetch);
    await http.request(URL_OK);
    expect(sleeps).toEqual([7000]);
  });

  it("keeps the backoff delay when Retry-After is shorter", async () => {
    const { fetch } = scripted(response(429, "", { "Retry-After": "0" }), response(200));
    const { http, sleeps } = client(fetch);
    await http.request(URL_OK);
    expect(sleeps).toEqual([1000]);
  });

  it("honours an HTTP-date Retry-After", async () => {
    const now = new Date("2026-10-07T10:00:00Z");
    const { fetch } = scripted(response(429, "", { "Retry-After": "Wed, 07 Oct 2026 10:00:09 GMT" }), response(200));
    const sleeps: number[] = [];
    const http = createHttpClient({
      settings: SETTINGS,
      fetch,
      now: () => now,
      random: () => 1,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await http.request(URL_OK);
    expect(sleeps).toEqual([9000]);
  });

  it("fails fast when Retry-After exceeds backoff_max_ms", async () => {
    const { fetch, calls } = scripted(response(429, "", { "Retry-After": "3600" }));
    const { http, sleeps } = client(fetch);
    await expect(http.request(URL_OK)).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 3_600_000 });
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("really waits Retry-After with fake timers", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = scripted(response(429, "", { "Retry-After": "2" }), response(200, "{}"));
    const http = createHttpClient({ settings: SETTINGS, fetch, random: () => 0 });
    const pending = http.request(URL_OK);
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(200);
    expect(calls()).toBe(2);
  });

  it("parses Retry-After values", () => {
    const now = new Date("2026-10-07T10:00:00Z");
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("1.5", now)).toBe(1500);
    expect(parseRetryAfter("Wed, 07 Oct 2026 09:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});

describe("error mapping", () => {
  it.each([
    [429, "rate_limited"],
    [401, "auth_expired"],
    [403, "blocked"],
    [999, "blocked"],
    [404, "unknown"],
  ] as const)("raises %i as %s", async (status, code) => {
    const { fetch } = scripted(response(status));
    const { http } = client(fetch, { maxRetries: 0 });
    await expect(http.request(URL_OK)).rejects.toMatchObject({ code, status });
  });

  it("does not retry non-retryable statuses", async () => {
    for (const status of [401, 403, 999, 404]) {
      const { fetch, calls } = scripted(response(status));
      await expect(client(fetch).http.request(URL_OK)).rejects.toBeInstanceOf(ChannelError);
      expect(calls()).toBe(1);
    }
  });

  it("classifies verification pages behind other statuses as blocked", async () => {
    const { fetch } = scripted(response(400, "<h1>Verify you are human</h1>"));
    await expect(client(fetch).http.request(URL_OK)).rejects.toMatchObject({ code: "blocked" });
  });

  it("returns statuses listed in allowStatus instead of raising", async () => {
    const { fetch } = scripted(response(404));
    const res = await client(fetch).http.request(URL_OK, { allowStatus: [404] });
    expect(res.status).toBe(404);
  });

  it("validates JSON bodies with zod and raises parse errors", async () => {
    const schema = z.object({ jobs: z.array(z.object({ id: z.string() })) });
    const good = scripted(response(200, JSON.stringify({ jobs: [{ id: "a" }] })));
    await expect(client(good.fetch).http.json(URL_OK, schema)).resolves.toEqual({ jobs: [{ id: "a" }] });
    const bad = scripted(response(200, JSON.stringify({ jobs: [{ id: 1 }] })));
    await expect(client(bad.fetch).http.json(URL_OK, schema)).rejects.toMatchObject({ code: "parse" });
    const notJson = scripted(response(200, "<html>"));
    await expect(client(notJson.fetch).http.json(URL_OK, schema)).rejects.toMatchObject({ code: "parse" });
  });
});

describe("timeouts and cancellation", () => {
  it("times out a hanging request as a retryable network error", async () => {
    vi.useFakeTimers();
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const http = createHttpClient({ settings: { ...SETTINGS, maxRetries: 0 }, fetch: hanging });
    const pending = http.request(URL_OK);
    const assertion = expect(pending).rejects.toMatchObject({ code: "network", retryable: true });
    await vi.advanceTimersByTimeAsync(SETTINGS.timeoutMs);
    await assertion;
  });

  it("honours a per-request timeout override", async () => {
    vi.useFakeTimers();
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const http = createHttpClient({ settings: { ...SETTINGS, maxRetries: 0 }, fetch: hanging });
    const pending = http.request(URL_OK, { timeoutMs: 60000 });
    const assertion = expect(pending).rejects.toThrowError(/timed out after 60000 ms/);
    await vi.advanceTimersByTimeAsync(SETTINGS.timeoutMs);
    await vi.advanceTimersByTimeAsync(60000);
    await assertion;
  });

  it("does not retry after the cycle signal aborts", async () => {
    const controller = new AbortController();
    const fetchFn: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        controller.abort();
      });
    const { http, sleeps } = client(fetchFn, {}, { signal: controller.signal });
    await expect(http.request(URL_OK)).rejects.toMatchObject({ name: "AbortError" });
    expect(sleeps).toEqual([]);
  });

  it("stops a backoff sleep when the signal aborts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { fetch, calls } = scripted(response(503), response(200));
    const http = createHttpClient({ settings: SETTINGS, fetch, signal: controller.signal, random: () => 1 });
    const pending = http.request(URL_OK);
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await assertion;
    expect(calls()).toBe(1);
  });
});

describe("a body that stalls after the headers", () => {
  /** Headers at once; the body only ends when the request is aborted (the timeout). */
  const stalling: FetchLike = async (_url, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
      },
    });
    const stalled = () => new Promise<never>((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    return { status: 200, ok: true, headers: { get: () => null }, body, text: stalled, json: stalled };
  };

  it.each(["text", "textUpTo", "json"] as const)("%s: the timeout is a network ChannelError, not a bare AbortError", async (read) => {
    const http = createHttpClient({ settings: { ...SETTINGS, timeoutMs: 30, maxRetries: 0 }, fetch: stalling });
    const response = await http.request("https://slow.example.test/");
    const reading = read === "textUpTo" ? response.textUpTo!(1024) : read === "json" ? response.json() : response.text();
    await expect(reading).rejects.toMatchObject({ name: "ChannelError", code: "network" });
  });

  it("http.json reports a stalled body as a network error, not a parse error", async () => {
    const http = createHttpClient({ settings: { ...SETTINGS, timeoutMs: 30, maxRetries: 0 }, fetch: stalling });
    await expect(http.json("https://slow.example.test/", z.object({}))).rejects.toMatchObject({ code: "network" });
  });

  it("a cancellation while the body streams stays a cancellation", async () => {
    const outer = new AbortController();
    const http = createHttpClient({ settings: { ...SETTINGS, timeoutMs: 5000, maxRetries: 0 }, fetch: stalling, signal: outer.signal });
    const response = await http.request("https://slow.example.test/");
    const reading = response.text();
    outer.abort(new Error("cycle cancelled"));
    await expect(reading).rejects.toThrow("cycle cancelled");
  });
});

describe("logging", () => {
  it("never logs headers, tokens or query strings", async () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ sink: (r) => records.push(r), minLevel: "debug" });
    const { fetch } = scripted(response(503), response(200));
    const http = createHttpClient({ settings: SETTINGS, fetch, logger, sleep: async () => {}, random: () => 1 });
    await http.request(URL_OK, { headers: { Authorization: "Bearer sekret-header" } });
    expect(records.length).toBeGreaterThan(0);
    const text = JSON.stringify(records);
    expect(text).not.toContain("sekret");
    expect(text).not.toContain("Bearer");
    expect(text).toContain("api.example.test");
  });
});

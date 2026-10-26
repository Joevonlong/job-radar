// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { MAX_RESPONSE_CHARS } from "@/lib/channels/linkedin/monid/contract";
import { defaultSleep } from "@/lib/channels/http";

import jobs from "../../../fixtures/monid/harvestapi-jobs.json";
import responses from "../../../fixtures/monid/responses.json";
import { completed, FAKE_KEY, harness, query, response, settings, type Answer } from "./helpers";

describe("Monid run flow", () => {
  it("runs once, then polls at the configured interval until completed", async () => {
    const h = await harness([response(202, responses.accepted), response(200, responses.running), response(200, completed({ output: jobs }))]);
    const postings = await h.channel.collect(query(), h.ctx);
    expect(postings.map((p) => p.externalId)).toEqual(["4385163817", "4385163818"]);
    expect(h.requests.map((r) => [r.method, r.path])).toEqual([["POST", "/v1/run"], ["GET", "/v1/runs/run_example"], ["GET", "/v1/runs/run_example"]]);
    expect(h.sleeps).toEqual([5, 5]);
    expect(h.requests[0]?.body).toMatchObject({ provider: "apify", endpoint: "/harvestapi/linkedin-job-search", input: { maxItems: 10 } });
    expect(h.ctx.budget.snapshot()).toMatchObject({ records: 2, usd: 0.003 });
  });

  it("handles synchronous 200 without polling", async () => {
    const h = await harness([response(200, completed({ output: jobs }))]);
    expect(await h.channel.collect(query(), h.ctx)).toHaveLength(2);
    expect(h.requests).toHaveLength(1);
  });

  it("handles 200 BLOCKED as a budget refusal and accounts terminal costs", async () => {
    const h = await harness([response(200, { ...responses.blocked, cost: { value: 0.002, currency: "USD" } })]);
    await expect(h.channel.collect(query(), h.ctx)).rejects.toMatchObject({ code: "budget_exceeded", retryable: false, tripsCircuit: false });
    expect(h.ctx.budget.snapshot().usd).toBe(0.002);
  });

  it.each([
    [401, "auth_expired", false], [402, "budget_exceeded", false], [403, "blocked", false], [400, "unknown", false],
    [404, "unknown", false], [408, "network", true], [429, "rate_limited", true], [502, "unknown", false], [503, "budget_exceeded", false],
  ] as const)("reads HTTP %i bodies and does not retry the billable POST", async (status, code, retryable) => {
    const read = vi.fn(async () => JSON.stringify({ error: FAKE_KEY }));
    const h = await harness([{ ...response(status, {}), text: read }]);
    await expect(h.channel.collect(query(), h.ctx)).rejects.toMatchObject({ code, retryable });
    expect(read).toHaveBeenCalledOnce();
    expect(h.requests).toHaveLength(1);
    expect(h.ctx.budget.snapshot().usd).toBe(0);
    expect(JSON.stringify(h.logs)).not.toContain(FAKE_KEY);
  });

  it("uses the body's terminal state even on HTTP 5xx and preserves its charge", async () => {
    const h = await harness([response(502, { status: "FAILED", cost: { value: 0.004, currency: "USD" } })]);
    await expect(h.channel.collect(query(), h.ctx)).rejects.toMatchObject({ code: "network", retryable: true });
    expect(h.ctx.budget.snapshot().usd).toBe(0.004);
    expect(h.requests).toHaveLength(1);
  });

  it("allows GET network failures to use the existing backoff, without repeating the POST", async () => {
    const h = await harness([response(202, responses.accepted), new TypeError("connection lost"), response(200, completed({ output: jobs }))]);
    expect(await h.channel.collect(query(), h.ctx)).toHaveLength(2);
    expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(h.requests.filter((r) => r.method === "GET")).toHaveLength(2);
    expect(h.logs.some((l) => l.message === "retrying request")).toBe(true);
  });

  it("classifies a missing run as non-retryable and conservatively charges the accepted run", async () => {
    const h = await harness([response(202, responses.accepted), response(404, responses.error)]);
    await expect(h.channel.collect(query(), h.ctx)).rejects.toMatchObject({ code: "unknown", retryable: false });
    expect(h.ctx.budget.snapshot().usd).toBe(0.011);
  });

  it("charges conservatively when the initial POST loses its connection, with no retry", async () => {
    const h = await harness([new TypeError(`transport echoed ${FAKE_KEY}`)]);
    const error: unknown = await h.channel.collect(query(), h.ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "network", retryable: true });
    expect(h.ctx.budget.snapshot().usd).toBe(0.011);
    expect(h.requests).toHaveLength(1);
    expect(h.logs.some((l) => l.level === "warn")).toBe(true);
    expect(JSON.stringify(error)).not.toContain(FAKE_KEY);
    expect(String(error)).not.toContain(FAKE_KEY);
  });

  it("charges conservatively when the initial POST times out while reading its body", async () => {
    const h = await harness([{ ...response(202, {}), text: async () => { throw new TypeError("body disconnected"); } }]);
    await expect(h.channel.collect(query(), h.ctx)).rejects.toMatchObject({ code: "network", retryable: true });
    expect(h.ctx.budget.snapshot().usd).toBe(0.011);
    expect(h.requests).toHaveLength(1);
  });

  it("warns when the accepted price is higher than configured", async () => {
    const h = await harness([response(202, { ...responses.accepted, price: { type: "PER_RESULT", amount: 0.002 } }), response(200, completed())]);
    await h.channel.collect(query(), h.ctx);
    expect(h.logs.some((l) => l.message === "monid advertised price exceeds configured price")).toBe(true);
  });
});

describe("timeout and stop", () => {
  const quick = () => settings({ timeout_ms: 5 });

  it("reaches stop at the absolute deadline when a GET hangs, instead of retrying past it", async () => {
    vi.useFakeTimers();
    try {
      const h = await harness([
        response(202, responses.accepted),
        (request) => new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new DOMException("Timed out GET", "AbortError")), { once: true });
        }),
        response(202, responses.stopping),
        response(200, completed({ output: jobs })),
      ], { now: () => new Date(), sleep: defaultSleep });
      const collected = h.channel.collect(query(), h.ctx);
      const outcome = collected.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30);
      expect(await outcome).toHaveLength(2);
      expect(h.requests.map((r) => [r.method, r.path])).toEqual([
        ["POST", "/v1/run"], ["GET", "/v1/runs/run_example"], ["POST", "/v1/runs/run_example/stop"], ["GET", "/v1/runs/run_example"],
      ]);
      expect(h.ctx.budget.snapshot().usd).toBe(0.003);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a hanging grace GET and conservatively settles once at grace expiry", async () => {
    vi.useFakeTimers();
    try {
      const h = await harness([
        response(202, responses.accepted), response(202, responses.stopping),
        (request) => new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new DOMException("Timed out GET", "AbortError")), { once: true });
        }),
      ], { settings: quick(), now: () => new Date(), sleep: defaultSleep });
      const outcome = h.channel.collect(query(), h.ctx).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(25);
      expect(await outcome).toMatchObject({ code: "network", retryable: true });
      expect(h.requests.map((r) => r.method)).toEqual(["POST", "POST", "GET"]);
      expect(h.ctx.budget.snapshot().usd).toBe(0.011);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out, stops, and retains a subsequently completed and billed result", async () => {
    const h = await harness([response(202, responses.accepted), response(202, responses.stopping), response(200, completed({ output: jobs }))], { settings: quick() });
    expect(await h.channel.collect(query(), h.ctx)).toHaveLength(2);
    expect(h.requests.map((r) => r.method)).toEqual(["POST", "POST", "GET"]);
    expect(h.requests[1]?.path).toBe("/v1/runs/run_example/stop");
    expect(h.ctx.budget.snapshot().usd).toBe(0.003);
  });

  it("records a STOPPED settlement as zero and reports the incomplete query", async () => {
    const h = await harness([response(202, responses.accepted), response(202, responses.stopping), response(200, responses.stopped)], { settings: quick() });
    await expect(h.channel.collect(query(), h.ctx)).rejects.toMatchObject({ code: "network", retryable: true });
    expect(h.ctx.budget.snapshot().usd).toBe(0);
  });

  it("records explicit costs on a STOPPED run", async () => {
    const h = await harness([response(202, responses.accepted), response(202, responses.stopping), response(200, { ...responses.stopped, cost: { value: 0.002, currency: "USD" } })], { settings: quick() });
    await expect(h.channel.collect(query(), h.ctx)).rejects.toMatchObject({ code: "network" });
    expect(h.ctx.budget.snapshot().usd).toBe(0.002);
  });

  it.each([false, true])("re-GETs after 409, including when it remains RUNNING: %s", async (stillRunning) => {
    const script: Answer[] = [response(202, responses.accepted), response(409, responses.conflict)];
    if (stillRunning) script.push(response(200, responses.running));
    script.push(response(200, completed({ output: jobs })));
    const h = await harness(script, { settings: quick() });
    expect(await h.channel.collect(query(), h.ctx)).toHaveLength(2);
    expect(h.requests.filter((r) => r.path.endsWith("/stop"))).toHaveLength(1);
    expect(h.requests.filter((r) => r.method === "GET")).toHaveLength(stillRunning ? 2 : 1);
    expect(h.ctx.budget.snapshot().usd).toBe(0.003);
  });

  it("charges the full configured limit on grace expiry and logs the run id", async () => {
    const h = await harness([response(202, responses.accepted), response(202, responses.stopping), response(200, responses.running)], { settings: quick() });
    await expect(h.channel.collect(query(), h.ctx)).rejects.toMatchObject({ code: "network", retryable: true });
    expect(h.ctx.budget.snapshot().usd).toBe(0.011);
    expect(h.logs.some((l) => l.level === "warn" && l.fields?.runId === "run_example")).toBe(true);
    expect(h.requests.filter((r) => r.path.endsWith("/stop"))).toHaveLength(1);
  });

  it.each([new TypeError("stop disconnected"), response(403, responses.error), response(202, "invalid JSON")])("charges conservatively and reports a retryable timeout when stop fails", async (failure) => {
    const h = await harness([response(202, responses.accepted), failure], { settings: quick() });
    await expect(h.channel.collect(query(), h.ctx)).rejects.toMatchObject({ code: "network", retryable: true });
    expect(h.ctx.budget.snapshot().usd).toBe(0.011);
  });

  it("charges conservatively when grace polling fails", async () => {
    const h = await harness([response(202, responses.accepted), response(202, responses.stopping), response(200, "invalid")], { settings: quick() });
    await expect(h.channel.collect(query(), h.ctx)).rejects.toMatchObject({ code: "network", retryable: true });
    expect(h.ctx.budget.snapshot().usd).toBe(0.011);
  });

  it("preserves the explicit non-retryable runs 404 mapping during grace polling", async () => {
    const h = await harness([response(202, responses.accepted), response(202, responses.stopping), response(404, responses.error)], { settings: quick() });
    await expect(h.channel.collect(query(), h.ctx)).rejects.toMatchObject({ code: "unknown", retryable: false, status: 404 });
    expect(h.ctx.budget.snapshot().usd).toBe(0.011);
  });
});

describe("cancellation and credential safety", () => {
  it("gives the independent cancellation stop its own short timeout", async () => {
    vi.useFakeTimers();
    try {
      const h = await harness([
        response(202, responses.accepted),
        (request) => new Promise((_resolve, reject) => {
          expect(request.signal.aborted).toBe(false);
          request.signal.addEventListener("abort", () => reject(new DOMException("Cleanup timed out", "AbortError")), { once: true });
        }),
      ], { now: () => new Date(), sleep: defaultSleep });
      const reason = new DOMException("Cycle cancelled", "AbortError");
      const original = h.ctx.http.request;
      h.ctx.http.request = async (url, init) => {
        const answer = await original(url, init);
        const read = answer.textUpTo!;
        return { ...answer, textUpTo: async (max) => { const body = await read(max); h.controller.abort(reason); return body; } };
      };
      const outcome = h.channel.collect(query(), h.ctx).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5);
      expect(await outcome).toBe(reason);
      expect(h.requests.map((r) => r.path)).toEqual(["/v1/run", "/v1/runs/run_example/stop"]);
      expect(h.ctx.budget.snapshot().usd).toBe(0.011);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])("sends an independent stop, accounts first, and then rethrows the abort: settled=%s", async (settled) => {
    const reason = new DOMException("Cancelled cycle", "AbortError");
    const stoppedBody = settled ? completed({ cost: { value: 0.004, currency: "USD" } }) : responses.stopping;
    const h2 = await harness([
      response(202, responses.accepted),
      (request) => {
        expect(request.signal.aborted).toBe(false);
        expect(request.redirect).toBe("error");
        expect(request.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
        return response(settled ? 200 : 202, stoppedBody);
      },
    ]);
    // Abort inside the poll sleep after the initial run id has been read.
    const original = h2.ctx.http.request;
    h2.ctx.http.request = async (url, init) => {
      const answer = await original(url, init);
      const read = answer.textUpTo;
      return { ...answer, textUpTo: read ? async (max) => { const body = await read(max); h2.controller.abort(reason); return body; } : undefined };
    };
    await expect(h2.channel.collect(query(), h2.ctx)).rejects.toBe(reason);
    expect(h2.requests.map((r) => r.path)).toEqual(["/v1/run", "/v1/runs/run_example/stop"]);
    expect(h2.ctx.budget.snapshot().usd).toBe(settled ? 0.004 : 0.011);
  });

  it("does not charge or send anything when the cycle was already cancelled", async () => {
    const h = await harness();
    h.controller.abort();
    await expect(h.channel.collect(query(), h.ctx)).rejects.toMatchObject({ name: "AbortError" });
    expect(h.ctx.budget.snapshot().usd).toBe(0);
    expect(h.requests).toHaveLength(0);
  });

  it("refuses redirects through the transport without following or exposing the key", async () => {
    const h = await harness([(request) => {
      expect(request.redirect).toBe("error");
      throw new TypeError(`redirect refused ${FAKE_KEY}`);
    }]);
    const error: unknown = await h.channel.collect(query(), h.ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "network" });
    expect(h.requests).toHaveLength(1);
    expect(JSON.stringify(h.logs)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(error)).not.toContain(FAKE_KEY);
  });

  it("puts the key only in Authorization, and never exposes echoed error bodies", async () => {
    const h = await harness([response(200, { status: "FAILED", reason: FAKE_KEY, error: { message: FAKE_KEY } })]);
    const error: unknown = await h.channel.collect(query(), h.ctx).catch((e: unknown) => e);
    expect(h.requests[0]?.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(h.requests.every((r) => !r.url.includes(FAKE_KEY) && !JSON.stringify(r.body).includes(FAKE_KEY))).toBe(true);
    expect(JSON.stringify(h.logs)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(error)).not.toContain(FAKE_KEY);
    expect(String(error)).not.toContain(FAKE_KEY);
  });

  it("rejects a credential echoed as a run id before using it in a URL or log", async () => {
    const h = await harness([response(202, { ...responses.accepted, runId: FAKE_KEY })]);
    await expect(h.channel.collect(query(), h.ctx)).rejects.toMatchObject({ code: "parse" });
    expect(h.requests).toHaveLength(1);
    expect(JSON.stringify(h.logs)).not.toContain(FAKE_KEY);
  });

  it("rejects an unapproved credential endpoint before sending", async () => {
    const h = await harness([], { settings: settings({ api_base_url: "https://unapproved.example" }) });
    await expect(h.channel.collect(query(), h.ctx)).rejects.toMatchObject({ code: "unknown", retryable: false });
    expect(h.requests).toHaveLength(0);
  });

  it.each(["{invalid", "x".repeat(MAX_RESPONSE_CHARS + 1)])("caps and validates response bodies without echoing them", async (body) => {
    const h = await harness([response(200, body)]);
    await expect(h.channel.collect(query(), h.ctx)).rejects.toMatchObject({ code: "parse", retryable: false });
  });
});

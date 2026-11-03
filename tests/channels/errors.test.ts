// @vitest-environment node
import { describe, expect, it } from "vitest";

import { BudgetExceededError, ChannelError, errorFromHttp, isAbortError, looksBlocked, PartialCollectError, settlePostings, toChannelError } from "@/lib/channels/errors";

describe("errorFromHttp", () => {
  describe("an unknown 4xx says why", () => {
    it("carries a short excerpt of the provider's answer", () => {
      const error = errorFromHttp(400, { where: "api.example.test", bodyExcerpt: '{"error":"dataset is not active"}' });
      expect(error?.code).toBe("unknown");
      expect(error?.retryable).toBe(false);
      expect(error?.message).toContain("dataset is not active");
    });

    it("keeps keys, tokens and query strings out of the excerpt", () => {
      const body = 'bad request for https://api.example.test/v1/run?keyword=secret-search&api_key=abc123 with Bearer sk_live_abcdef api_key=abc123 "token":"tok-987" a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
      const message = errorFromHttp(400, { bodyExcerpt: body })?.message ?? "";
      expect(message).toContain("bad request");
      expect(message).toContain("https://api.example.test/v1/run");
      for (const secret of ["secret-search", "abc123", "sk_live_abcdef", "tok-987", "a1b2c3d4e5f6"]) expect(message).not.toContain(secret);
    });

    it("keeps the excerpt short and on one line, and leaves an HTML page out", () => {
      const message = errorFromHttp(404, { where: "x.test", bodyExcerpt: `first\nsecond ${"word ".repeat(200)}` })?.message ?? "";
      expect(message).not.toContain("\n");
      expect(message.length).toBeLessThan(200);
      expect(errorFromHttp(404, { where: "x.test", bodyExcerpt: "<!doctype html><html><body>Not here</body></html>" })?.message).toBe("HTTP 404 from x.test");
      expect(errorFromHttp(404, { where: "x.test", bodyExcerpt: "   " })?.message).toBe("HTTP 404 from x.test");
    });

    it.each(["Insufficient balance", "No credits left on this account", "Monthly QUOTA exceeded"])("a 400 saying %s is a budget failure", (body) => {
      const error = errorFromHttp(400, { where: "api.example.test", bodyExcerpt: body });
      expect(error).toBeInstanceOf(BudgetExceededError);
      expect(error?.code).toBe("budget_exceeded");
      expect(error?.message).toContain(body);
    });

    it("another status, or a word that only contains one of those, stays unknown", () => {
      expect(errorFromHttp(404, { bodyExcerpt: "quota" })?.code).toBe("unknown");
      expect(errorFromHttp(400, { bodyExcerpt: "unbalanced parentheses in the query" })?.code).toBe("unknown");
    });
  });

  it.each([
    [429, "rate_limited", true],
    [401, "auth_expired", false],
    [403, "blocked", false],
    [999, "blocked", false],
    [500, "network", true],
    [503, "network", true],
    [408, "network", true],
    [404, "unknown", false],
    [400, "unknown", false],
  ] as const)("maps HTTP %i to %s (retryable: %s)", (status, code, retryable) => {
    const error = errorFromHttp(status);
    expect(error).toBeInstanceOf(ChannelError);
    expect(error?.code).toBe(code);
    expect(error?.retryable).toBe(retryable);
    expect(error?.status).toBe(status);
  });

  it("returns null for success statuses", () => {
    expect(errorFromHttp(200)).toBeNull();
    expect(errorFromHttp(302)).toBeNull();
  });

  it("treats verification pages on any error status as blocked", () => {
    expect(errorFromHttp(400, { bodyExcerpt: "<html>Please complete the CAPTCHA</html>" })?.code).toBe("blocked");
    expect(errorFromHttp(404, { bodyExcerpt: "not found" })?.code).toBe("unknown");
  });

  it("carries Retry-After and never puts the body into the message", () => {
    const error = errorFromHttp(429, { retryAfterMs: 5000, bodyExcerpt: "secret-token-123", where: "example.test" });
    expect(error?.retryAfterMs).toBe(5000);
    expect(error?.message).not.toContain("secret-token");
    expect(error?.message).toContain("example.test");
  });
});

describe("looksBlocked", () => {
  it("recognises common bot-detection markers", () => {
    for (const body of ["Captcha required", "authwall", "We detected unusual traffic", "Please verify you are human", "Are you a robot?"]) {
      expect(looksBlocked(body)).toBe(true);
    }
    expect(looksBlocked("<html>3 jobs found</html>")).toBe(false);
  });
});

describe("ChannelError", () => {
  it("defaults retryable per code and allows overriding it", () => {
    expect(new ChannelError("rate_limited", "x").retryable).toBe(true);
    expect(new ChannelError("rate_limited", "x").tripsCircuit).toBe(false);
    expect(new ChannelError("rate_limited", "x", { retryable: false, tripsCircuit: true })).toMatchObject({ retryable: false, tripsCircuit: true });
    expect(new ChannelError("network", "x").retryable).toBe(true);
    for (const code of ["blocked", "auth_expired", "budget_exceeded", "parse", "unknown"] as const) {
      expect(new ChannelError(code, "x").retryable).toBe(false);
    }
    expect(new ChannelError("network", "x", { retryable: false }).retryable).toBe(false);
  });

  it("BudgetExceededError is a non-retryable budget_exceeded ChannelError", () => {
    const error = new BudgetExceededError("global", "cap reached");
    expect(error).toBeInstanceOf(ChannelError);
    expect(error.code).toBe("budget_exceeded");
    expect(error.retryable).toBe(false);
    expect(error.scope).toBe("global");
  });

  it("toChannelError keeps ChannelErrors and wraps everything else as unknown", () => {
    const original = new ChannelError("blocked", "x");
    expect(toChannelError(original)).toBe(original);
    const wrapped = toChannelError(new TypeError("boom"));
    expect(wrapped.code).toBe("unknown");
    expect(wrapped.retryable).toBe(false);
    expect(wrapped.message).toContain("boom");
    expect(toChannelError("a string").code).toBe("unknown");
  });

  it("PartialCollectError carries the postings and the original failure; toChannelError unwraps it to that failure", () => {
    const cause = new ChannelError("blocked", "HTTP 403 from x: request blocked", { status: 403, tripsCircuit: true });
    const postings = [{ externalId: "1", url: "https://x.test/1", payload: {}, postedAt: null }];
    const partial = new PartialCollectError(postings, cause);
    expect(partial).toBeInstanceOf(Error);
    expect(partial).not.toBeInstanceOf(ChannelError);
    expect(partial.cause).toBe(cause);
    expect(partial.postings).toEqual(postings);
    expect(partial.message).toContain("request blocked");
    expect(toChannelError(partial)).toBe(cause);
    const budget = new BudgetExceededError("channel", "cap");
    expect(toChannelError(new PartialCollectError(postings, budget))).toBe(budget);
  });

  describe("settlePostings", () => {
    const postings = [{ externalId: "1", url: "https://x.test/1", payload: {}, postedAt: null }];
    const cause = new ChannelError("network", "HTTP 503 from x: server error", { status: 503 });
    const booked: number[] = [];
    const paying = { consume: async (records: number) => (booked.push(records), { usd: 0, freeRecords: records, paidRecords: 0 }) };
    const refusing = {
      consume: async (): Promise<never> => {
        throw new BudgetExceededError("channel", "cap");
      },
    };
    const broken = {
      consume: async (): Promise<never> => {
        throw new Error("usage store down");
      },
    };
    const settled = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);

    it("books and returns the postings of a complete query; a budget refusal stops it", async () => {
      booked.length = 0;
      await expect(settlePostings(paying, postings, null)).resolves.toBe(postings);
      expect(booked).toEqual([1]);
      await expect(settlePostings(refusing, postings, null)).rejects.toBeInstanceOf(BudgetExceededError);
    });

    it("books an interrupted query's postings and throws them with the original cause", async () => {
      booked.length = 0;
      const error = await settled(settlePostings(paying, postings, cause));
      expect(error).toBeInstanceOf(PartialCollectError);
      expect((error as PartialCollectError).cause).toBe(cause);
      expect(booked).toEqual([1]);
    });

    it("keeps an interrupted query's postings and cause when the budget refuses them", async () => {
      const error = await settled(settlePostings(refusing, postings, cause));
      expect(error).toBeInstanceOf(PartialCollectError);
      expect((error as PartialCollectError).cause).toBe(cause);
      expect((error as PartialCollectError).postings).toEqual(postings);
    });

    it("passes any other budget error on", async () => {
      const error = await settled(settlePostings(broken, postings, cause));
      expect(error).not.toBeInstanceOf(PartialCollectError);
      expect((error as Error).message).toBe("usage store down");
    });
  });

  it("detects abort and timeout errors", () => {
    expect(isAbortError(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAbortError(new DOMException("x", "TimeoutError"))).toBe(true);
    expect(isAbortError(new Error("x"))).toBe(false);
  });
});

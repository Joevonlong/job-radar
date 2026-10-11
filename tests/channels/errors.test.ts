// @vitest-environment node
import { describe, expect, it } from "vitest";

import { BudgetExceededError, ChannelError, errorFromHttp, isAbortError, looksBlocked, toChannelError } from "@/lib/channels/errors";

describe("errorFromHttp", () => {
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

  it("detects abort and timeout errors", () => {
    expect(isAbortError(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAbortError(new DOMException("x", "TimeoutError"))).toBe(true);
    expect(isAbortError(new Error("x"))).toBe(false);
  });
});

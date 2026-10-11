// @vitest-environment node
import { describe, expect, it } from "vitest";

import { LoginThrottle, throttleKey, type ThrottleLimits } from "@/lib/security/login-throttle";

const limits: ThrottleLimits = { maxFailures: 3, windowMs: 60_000, lockoutMs: 120_000, globalMaxFailures: 5, globalDelayMs: 2_000 };

function clock() {
  let now = 1_000_000;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("LoginThrottle", () => {
  it("locks a key after maxFailures within the window, with a Retry-After", () => {
    const c = clock();
    const throttle = new LoginThrottle(c.now);
    expect(throttle.recordFailure("a", limits).locked).toBe(false);
    expect(throttle.recordFailure("a", limits).locked).toBe(false);
    expect(throttle.check("a")).toEqual({ allowed: true });
    expect(throttle.recordFailure("a", limits).locked).toBe(true);
    expect(throttle.check("a")).toEqual({ allowed: false, retryAfterSeconds: 120 });
    expect(throttle.check("b")).toEqual({ allowed: true });
    c.advance(119_500);
    expect(throttle.check("a")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    c.advance(1_000);
    expect(throttle.check("a")).toEqual({ allowed: true });
  });

  it("failures outside the window do not add up", () => {
    const c = clock();
    const throttle = new LoginThrottle(c.now);
    throttle.recordFailure("a", limits);
    throttle.recordFailure("a", limits);
    c.advance(61_000);
    expect(throttle.recordFailure("a", limits).locked).toBe(false);
  });

  it("a success clears the key", () => {
    const throttle = new LoginThrottle(clock().now);
    throttle.recordFailure("a", limits);
    throttle.recordFailure("a", limits);
    throttle.recordSuccess("a");
    expect(throttle.recordFailure("a", limits).locked).toBe(false);
  });

  it("past the global limit every login waits, longer with each further failure (rotating sources does not help)", () => {
    const c = clock();
    const throttle = new LoginThrottle(c.now);
    // a window long enough that no failure ages out during the test
    const wide = { ...limits, windowMs: 3_600_000 };
    for (let i = 0; i < 4; i++) expect(throttle.recordFailure(`k${i}`, wide)).toEqual({ locked: false, globalDelaySeconds: null });
    // the fifth failure from all sources together: a short wait for everybody, not a 2-minute lock
    expect(throttle.recordFailure("k4", wide)).toEqual({ locked: false, globalDelaySeconds: 2 });
    expect(throttle.check("someone-new")).toEqual({ allowed: false, retryAfterSeconds: 2 });
    c.advance(2_000);
    expect(throttle.check("someone-new")).toEqual({ allowed: true });
    // each further failure doubles the wait
    expect(throttle.recordFailure("k5", wide).globalDelaySeconds).toBe(4);
    c.advance(4_000);
    expect(throttle.recordFailure("k6", wide).globalDelaySeconds).toBe(8);
    c.advance(8_000);
    // ... up to the lockout at most
    for (let i = 0; i < 6; i++) {
      const { globalDelaySeconds } = throttle.recordFailure(`m${i}`, wide);
      c.advance((globalDelaySeconds ?? 0) * 1000);
    }
    expect(throttle.recordFailure("m9", wide).globalDelaySeconds).toBe(120);
  });

  it("the global wait does not apply to a request that already has a valid session", () => {
    const throttle = new LoginThrottle(clock().now);
    for (let i = 0; i < 5; i++) throttle.recordFailure(`k${i}`, limits);
    expect(throttle.check("me").allowed).toBe(false);
    expect(throttle.check("me", { skipGlobal: true })).toEqual({ allowed: true });
    // the per-source lock still holds
    for (let i = 0; i < 3; i++) throttle.recordFailure("me", limits);
    expect(throttle.check("me", { skipGlobal: true }).allowed).toBe(false);
  });

  it("failures that age out of the window end the global wait", () => {
    const c = clock();
    const throttle = new LoginThrottle(c.now);
    for (let i = 0; i < 5; i++) throttle.recordFailure(`k${i}`, limits);
    c.advance(61_000);
    expect(throttle.check("x")).toEqual({ allowed: true });
    expect(throttle.recordFailure("x", limits).globalDelaySeconds).toBeNull();
  });

  it("throttleKey: the last X-Forwarded-For entry (added by the nearest hop), else direct", () => {
    expect(throttleKey(null)).toBe("direct");
    expect(throttleKey(" ")).toBe("direct");
    expect(throttleKey("100.64.0.2")).toBe("100.64.0.2");
    // a client-supplied first entry in front of the address the proxy saw: rotating it changes nothing
    expect(throttleKey("1.2.3.4, 100.64.0.2")).toBe("100.64.0.2");
    expect(throttleKey("5.6.7.8 , 100.64.0.2 ")).toBe("100.64.0.2");
    expect(throttleKey("x".repeat(500)).length).toBe(100);
  });
});

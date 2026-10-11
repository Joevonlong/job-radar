// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TimeoutError, withTimeout } from "@/lib/ops/timeout";

describe("withTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("passes the result of work that settles in time", async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, "x")).resolves.toBe(7);
  });

  it("gives up on work that never settles, and a late rejection stays quiet", async () => {
    let fail: (e: Error) => void = () => {};
    const stuck = new Promise<never>((_, reject) => { fail = reject; });
    const result = withTimeout(stuck, 5000, "disk measurement");
    const assertion = expect(result).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    await expect(result).rejects.toThrow("disk measurement did not finish within 5s");
    fail(new Error("late"));
    await vi.advanceTimersByTimeAsync(10);
  });
});

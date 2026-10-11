import { describe, expect, it } from "vitest";

import { AiProviderError } from "@/lib/ai/errors";
import { failedBecauseAborted } from "@/lib/control/poller";

describe("failedBecauseAborted", () => {
  const aborted = AbortSignal.abort();
  const live = new AbortController().signal;
  const failed = (error: string) => ({ status: "failed" as const, result: { error } });

  it("is true for an aborted outcome or a thrown abort error while the signal is aborted", () => {
    expect(failedBecauseAborted(failed("aborted"), undefined, aborted)).toBe(true);
    expect(failedBecauseAborted(failed("handler_error"), Object.assign(new Error("x"), { name: "AbortError" }), aborted)).toBe(true);
    expect(failedBecauseAborted(failed("handler_error"), new AiProviderError("claude-cli", "aborted", "stopped"), aborted)).toBe(true);
  });

  it("is false for a genuine failure, even during shutdown, and when the signal is live", () => {
    expect(failedBecauseAborted(failed("invalid_payload"), undefined, aborted)).toBe(false);
    expect(failedBecauseAborted(failed("handler_error"), new Error("quota exceeded"), aborted)).toBe(false);
    expect(failedBecauseAborted(failed("aborted"), undefined, live)).toBe(false);
    expect(failedBecauseAborted({ status: "done", result: {} }, undefined, aborted)).toBe(false);
  });
});

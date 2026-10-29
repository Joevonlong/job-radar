// @vitest-environment node
import { describe, expect, it } from "vitest";
import { spanScope } from "@/lib/activity/scope";
import { AiProviderError } from "@/lib/ai/errors";
import { fakeRecorder } from "./helpers";

describe("span scope", () => {
  it.each(["ok", "partial", "failed", "skipped", "interrupted"] as const)("finishes a %s outcome once", (status) => {
    const fake = fakeRecorder();
    const scope = spanScope(fake.recorder.systemRoot("system.backup"));
    try { scope.set(status, status === "skipped" ? "cycle_cancelled" : undefined); }
    finally { scope.close(); }
    scope.close();
    expect(fake.spans[0]?.finishes).toEqual([[status, status === "skipped" ? { reasonCode: "cycle_cancelled" } : undefined]]);
  });

  it.each([new Error("private payload"), new AiProviderError("codex-cli", "aborted", "private payload")])("preserves the same thrown value and closes once", (error) => {
    const fake = fakeRecorder();
    const scope = spanScope(fake.recorder.systemRoot("system.backup"));
    let caught: unknown;
    try {
      try { throw error; }
      catch (thrown) { scope.error(thrown); throw thrown; }
      finally { scope.close(); }
    } catch (thrown) { caught = thrown; }
    expect(caught).toBe(error);
    expect(fake.spans[0]?.finishes).toEqual([["failed", { reasonCode: error instanceof AiProviderError ? "aborted" : "error" }]]);
  });
});

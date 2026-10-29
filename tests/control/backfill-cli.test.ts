// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { parseBackfillArg, submitBackfill, validateBackfillCliArgs } from "@/lib/control/backfill-arg";
import type { ControlActionState } from "@/lib/control/service-types";

it.each([["36h", 36], ["3d", 72], ["1h", 1], ["720h", 720], ["30d", 720]])("parses %s", (text, hours) => {
  expect(parseBackfillArg(String(text))).toBe(hours);
});
it.each(["0h", "721h", "31d", "1.5h", "h", "36", "36m", "-1h", "999999999999999999999d"])("rejects %s", (text) => {
  expect(parseBackfillArg(text)).toBeNull();
});
it("rejects a dry run or a non-manual kind", () => {
  expect(validateBackfillCliArgs({ dryRun: true, kind: "manual" })).toContain("a dry run does not use it");
  expect(validateBackfillCliArgs({ dryRun: false, kind: "weekend" })).toContain("--kind manual");
  expect(validateBackfillCliArgs({ dryRun: false, kind: "manual" })).toBeNull();
});

describe("queue submission", () => {
  it.each([{ channelIds: [] }, { channelIds: ["linkedin-guest"] }])("only calls the request dependency for scope $channelIds", async ({ channelIds }) => {
    const request = vi.fn(async (): Promise<ControlActionState> => ({ status: "queued", request: 42, kind: "run_cycle", existing: false, nonce: 1 }));
    const out = vi.fn();
    const err = vi.fn();
    expect(await submitBackfill({ hours: 48, channelIds }, { request, out, err })).toBe(0);
    expect(request).toHaveBeenCalledExactlyOnceWith({ backfillHours: 48, ...(channelIds.length ? { channelIds } : {}) });
    expect(out).toHaveBeenCalledWith("backfill request #42 queued (48 h); the runner executes it, follow it on /sources");
    expect(err).not.toHaveBeenCalled();
  });
  it.each(["backfillOverLimit", "cycleBusy", "unknownChannel", "invalidPayload", "databaseUnavailable"] as const)("reports %s and fails", async (error) => {
    const err = vi.fn();
    expect(await submitBackfill({ hours: 48, channelIds: [] }, { request: async () => ({ status: "error", error, maxBackfillHours: 24, nonce: 1 }), out: vi.fn(), err })).toBe(1);
    expect(err).toHaveBeenCalledOnce();
    if (error === "backfillOverLimit") expect(err.mock.calls[0]?.[0]).toContain("24 h");
  });
});

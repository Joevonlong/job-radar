// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";

import { backfillAction } from "@/app/control-actions";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/control/service", () => ({ requestRunCycle: request }));
beforeEach(() => request.mockReset().mockResolvedValue({ status: "queued", request: 1, kind: "run_cycle", existing: false, nonce: 1 }));
it("forwards only a validated backfill payload", async () => {
  await backfillAction({ backfillHours: 48, channelIds: ["linkedin-guest"] });
  expect(request).toHaveBeenCalledExactlyOnceWith({ backfillHours: 48, channelIds: ["linkedin-guest"] });
});
it.each([null, {}, { backfillHours: "48" }, { backfillHours: 721 }, { backfillHours: 48, extra: true }, { backfillHours: 48, channelIds: [] }])("rejects malformed input %j before submitting", async (payload) => {
  expect(await backfillAction(payload)).toMatchObject({ status: "error", error: "invalidPayload" });
  expect(request).not.toHaveBeenCalled();
});

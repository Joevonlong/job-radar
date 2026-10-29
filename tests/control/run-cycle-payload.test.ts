// @vitest-environment node
import { describe, expect, it } from "vitest";

import { runCyclePayloadSchema } from "@/lib/control/types";

describe("manual cycle payload", () => {
  it.each([1, 720])("accepts backfillHours=%s with or without channel selection", (backfillHours) => {
    for (const payload of [{ backfillHours }, { backfillHours, channelIds: ["indeed"] }]) {
      expect(runCyclePayloadSchema.parse(payload)).toEqual(payload);
    }
  });

  it.each([0, 721, 1.5, "36", null])("rejects backfillHours=%j", (backfillHours) => {
    expect(runCyclePayloadSchema.safeParse({ backfillHours }).success).toBe(false);
  });

  it("keeps plain requests valid and rejects unknown keys", () => {
    expect(runCyclePayloadSchema.parse({})).toEqual({});
    expect(runCyclePayloadSchema.safeParse({ backfillHours: 36, surprise: true }).success).toBe(false);
  });
});

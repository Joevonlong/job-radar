import { describe, expect, it } from "vitest";

import { ACTION_RULES, decodeCallback, encodeCallback } from "@/lib/notify/callbacks";

describe("callback data", () => {
  it("round-trips every action and stays within 64 bytes", () => {
    for (const action of ["interested", "ignore", "resume", "favorite", "unfavorite"] as const) {
      const data = encodeCallback(999_999_999_999_999, action);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(decodeCallback(data)).toEqual({ jobId: 999_999_999_999_999, action });
    }
    expect(encodeCallback(42, "interested")).toBe("a:42:i");
    expect(encodeCallback(42, "favorite")).toBe("a:42:f");
    expect(encodeCallback(42, "unfavorite")).toBe("a:42:u");
  });

  it("still decodes the codes of messages sent before the favorites", () => {
    expect(decodeCallback("a:7:i")).toEqual({ jobId: 7, action: "interested" });
    expect(decodeCallback("a:7:x")).toEqual({ jobId: 7, action: "ignore" });
    expect(decodeCallback("a:7:r")).toEqual({ jobId: 7, action: "resume" });
  });

  it.each([
    "",
    "a:42",
    "a:42:",
    "a:42:z",
    "a:42:F",
    "a:0:i",
    "a:042:i",
    "a:-1:i",
    "a:1.5:i",
    "a:1:i:extra",
    "b:42:i",
    "a:1234567890123456:i", // 16 digits: beyond the safe range we accept
    " a:42:i",
    "a:42:i\n",
    "a:４２:i", // full-width digits
  ])("rejects %j", (data) => {
    expect(decodeCallback(data)).toBeNull();
  });

  it("refuses to encode an invalid job id", () => {
    expect(() => encodeCallback(0, "ignore")).toThrow(RangeError);
    expect(() => encodeCallback(1.5, "ignore")).toThrow(RangeError);
  });
});

describe("action rules", () => {
  it("never allow undoing progress made on the dashboard", () => {
    for (const rule of Object.values(ACTION_RULES)) {
      expect(rule.allowFrom).not.toContain("applied");
      expect(rule.allowFrom).not.toContain("interviewing");
      expect(rule.allowFrom).not.toContain("offer");
    }
  });
});

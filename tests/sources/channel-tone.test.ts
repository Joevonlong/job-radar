// @vitest-environment node
import { describe, expect, it } from "vitest";

import { outcomeTone, statusTone } from "@/lib/sources/channel-tone";

describe("one colour mapping for Today's channel chips and the /sources cards", () => {
  it("a missing key is yellow on both, red is for failures only", () => {
    expect(statusTone("missing_credentials")).toBe("warn");
    expect(outcomeTone({ outcome: "ok", keyMissing: true })).toBe("warn");
    expect(statusTone("failing")).toBe("bad");
    expect(statusTone("open")).toBe("bad");
    expect(outcomeTone({ outcome: "failed", keyMissing: false })).toBe("bad");
    expect(outcomeTone({ outcome: "circuit_open", keyMissing: true })).toBe("bad");
  });

  it("ok is green, a skipped run and a degraded channel are yellow, off channels are neutral", () => {
    expect(statusTone("ok")).toBe("good");
    expect(outcomeTone({ outcome: "ok", keyMissing: false })).toBe("good");
    expect(outcomeTone({ outcome: "skipped", keyMissing: false })).toBe("warn");
    // a query that failed after some pages: something arrived, but not everything
    expect(outcomeTone({ outcome: "interrupted", keyMissing: false })).toBe("warn");
    expect(statusTone("degraded")).toBe("warn");
    expect(statusTone("off")).toBe("idle");
  });
});

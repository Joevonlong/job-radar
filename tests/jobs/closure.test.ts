// @vitest-environment node
import { describe, expect, it } from "vitest";

import { closedReason, effectiveJobStatus, type AutoStatus, type ClosureAction } from "@/lib/jobs/closure";
import { parseLinkCheck } from "@/lib/jobs/link-check-evidence";

const AUTO: readonly AutoStatus[] = ["active", "possibly_closed", "closed"];

describe("effectiveJobStatus", () => {
  it.each([
    // [auto, override, effective]
    ["active", null, "active"],
    ["possibly_closed", null, "possibly_closed"],
    ["closed", null, "closed"],
    ["active", "closed", "closed"],
    ["possibly_closed", "closed", "closed"],
    ["closed", "closed", "closed"],
    ["active", "open", "active"],
    // "still open" also clears a possibly-closed mark (the one-click answer to a phrase hit)
    ["possibly_closed", "open", "active"],
    ["closed", "open", "active"],
  ] as const)("%s + %s → %s", (auto, override, expected) => {
    expect(effectiveJobStatus(auto, override as ClosureAction | null)).toBe(expected);
  });
});

describe("closedReason", () => {
  it("names the user's close, the takedown, the phrase and the plain possibly closed; nothing for an open job", () => {
    for (const auto of AUTO) expect(closedReason(auto, "closed", null)).toBe("manual");
    for (const auto of AUTO) expect(closedReason(auto, "open", "phrase")).toBeNull();
    expect(closedReason("closed", null, "gone")).toBe("gone");
    expect(closedReason("closed", null, null)).toBe("gone");
    expect(closedReason("possibly_closed", null, "phrase")).toBe("phrase");
    expect(closedReason("possibly_closed", null, "unknown")).toBe("possibly");
    expect(closedReason("possibly_closed", null, null)).toBe("possibly");
    expect(closedReason("active", null, "alive")).toBeNull();
  });
});

describe("parseLinkCheck", () => {
  it("reads stored evidence and refuses anything else", () => {
    const evidence = { outcome: "phrase", httpStatus: 200, phrase: "no longer accepting", quote: "… no longer accepting applications …", url: "https://jobs.example/1", at: "2026-10-10T08:00:00.000Z" };
    expect(parseLinkCheck(evidence)).toEqual(evidence);
    expect(parseLinkCheck(null)).toBeNull();
    expect(parseLinkCheck({ ...evidence, outcome: "maybe" })).toBeNull();
    expect(parseLinkCheck("text")).toBeNull();
  });
});

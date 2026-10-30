import { describe, expect, it } from "vitest";
import { DISPLAY_STATUS_CODES, displayChildStatus, displayStatus, type DisplayStatusRow } from "@/lib/activity/display-status";

const now = new Date("2026-10-20T12:00:00Z");
function row(overrides: Partial<DisplayStatusRow> = {}): DisplayStatusRow {
  return { scope: "cycle", status: "ok", cycleStatus: "succeeded", runAi: null, request: null, isCurrentAttempt: false,
    startedAt: new Date(now.getTime() - 10_000), latestHeartbeatAgeSeconds: 5, newerStartup: false, observedAt: now,
    liveness: { staleAfterSeconds: 60, startupGraceSeconds: 30 }, ...overrides };
}
const request = (status: NonNullable<DisplayStatusRow["request"]>["status"]): NonNullable<DisplayStatusRow["request"]> => ({ kind: "translate_job", status, errorCode: null });

describe("activity display status", () => {
  it("exports every display code once", () => { expect(new Set(DISPLAY_STATUS_CODES).size).toBe(DISPLAY_STATUS_CODES.length); });
  it("prioritizes a running cycle over spans and queued AI", () => {
    expect(displayStatus(row({ cycleStatus: "running", status: "failed", runAi: { status: "pending" } })).code).toBe("running");
  });
  it.each([["pending", "ai_queued"], ["running", "ai_running"]] as const)("shows live AI %s after collection", (status, code) => {
    expect(displayStatus(row({ runAi: { status } })).code).toBe(code);
  });
  it.each(["ok", "partial", "failed", "skipped", "interrupted", "unknown"] as const)("retains own final cycle status %s", (status) => {
    expect(displayStatus(row({ status })).code).toBe(status);
  });
  it("does not infer success from the cycle when the span still runs", () => {
    expect(displayStatus(row({ status: "running" }))).toEqual({ code: "possibly_interrupted", possiblyInterrupted: true });
  });
  it("keeps history interrupted after the request succeeds, with no current-request label", () => {
    expect(displayStatus(row({ scope: "request", status: "interrupted", request: request("done") }))).toEqual({ code: "interrupted", possiblyInterrupted: false });
  });
  it.each(["pending", "running", "done", "failed"] as const)("labels only the current attempt with request status %s", (status) => {
    expect(displayStatus(row({ scope: "request", request: request(status), isCurrentAttempt: true }))).toEqual({ code: "ok", requestCurrent: status, possiblyInterrupted: false });
  });
  it("shows a current interrupted attempt as requeued only while pending", () => {
    expect(displayStatus(row({ scope: "request", status: "interrupted", request: request("pending"), isCurrentAttempt: true })).code).toBe("requeued");
    expect(displayStatus(row({ scope: "request", status: "interrupted", request: request("pending") })).code).toBe("interrupted");
  });
  it.each(["done", "failed"] as const)("flags a running request span with terminal business status %s", (status) => {
    expect(displayStatus(row({ scope: "request", status: "running", request: request(status), isCurrentAttempt: true }))).toEqual({ code: "possibly_interrupted", requestCurrent: status, possiblyInterrupted: true });
  });
  it.each(["pending", "running"] as const)("keeps live request status %s running", (status) => {
    expect(displayStatus(row({ scope: "request", status: "running", request: request(status) })).code).toBe("running");
  });
  it.each([null, "unknown"] as const)("keeps a cycle with missing/unknown business status %s compatible", (cycleStatus) => {
    expect(displayStatus(row({ status: "running", cycleStatus })).code).toBe("running");
  });
  it("keeps missing or unknown request data compatible", () => {
    expect(displayStatus(row({ scope: "request", status: "running" })).code).toBe("running");
    expect(displayStatus(row({ scope: "request", status: "unknown", request: request("unknown") })).code).toBe("unknown");
  });
  it.each([
    { latestHeartbeatAgeSeconds: 60, newerStartup: false, expected: "running" },
    { latestHeartbeatAgeSeconds: 61, newerStartup: false, expected: "possibly_interrupted" },
    { latestHeartbeatAgeSeconds: 2, newerStartup: true, expected: "possibly_interrupted" },
    { latestHeartbeatAgeSeconds: null, newerStartup: false, expected: "running" },
  ] as const)("uses configured system liveness $expected ($latestHeartbeatAgeSeconds, $newerStartup)", ({ expected, ...input }) => {
    expect(displayStatus(row({ scope: "system", status: "running", ...input })).code).toBe(expected);
  });
  it("uses startup grace without heartbeat, including its boundary", () => {
    const system = row({ scope: "system", status: "running", latestHeartbeatAgeSeconds: null });
    expect(displayStatus({ ...system, startedAt: new Date(now.getTime() - 30_000) }).code).toBe("running");
    expect(displayStatus({ ...system, startedAt: new Date(now.getTime() - 30_001) }).code).toBe("possibly_interrupted");
  });
  it("advances heartbeat age at render time, and never compares heartbeat time to start time", () => {
    const system = row({ scope: "system", status: "running", latestHeartbeatAgeSeconds: 10, startedAt: new Date(now.getTime() - 5000) });
    expect(displayStatus(system).code).toBe("running");
    expect(displayStatus(system, new Date(now.getTime() + 51_000)).code).toBe("possibly_interrupted");
  });
  it.each(["ok", "partial", "failed", "skipped", "interrupted", "unknown"] as const)("does not replace terminal/unknown system status %s", (status) => {
    expect(displayStatus(row({ scope: "system", status, newerStartup: true })).code).toBe(status);
  });
  it("handles unknown scope via the span's own status", () => {
    expect(displayStatus(row({ scope: "unknown", status: "unknown" })).code).toBe("unknown");
  });
  it("children use their own status and their root's activity", () => {
    expect(displayChildStatus({ status: "running" }, { active: false }).code).toBe("possibly_interrupted");
    expect(displayChildStatus({ status: "running" }, { active: true }).code).toBe("running");
    expect(displayChildStatus({ status: "interrupted" }, { active: true }).code).toBe("interrupted");
    expect(displayChildStatus({ status: "unknown" }, { active: false }).code).toBe("unknown");
  });
});

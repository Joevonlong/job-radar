import { describe, expect, it } from "vitest";

import { ageParts } from "@/lib/settings/age";
import { ackState } from "@/lib/settings/ack";
import { controlStatusSchema, statusNeedsPolling, type ControlStatus } from "@/lib/settings/status-schema";
import { heartbeatView } from "@/lib/settings/status";

const NOW = new Date("2026-10-07T12:00:00Z");

function status(extra: Partial<ControlStatus> = {}): ControlStatus {
  const ack = { state: "loaded" as const, loadedAt: NOW.toISOString() };
  return {
    now: NOW.toISOString(),
    heartbeat: { at: NOW.toISOString(), ageSeconds: 3, online: true },
    staleScores: 0,
    unscoredJobs: 0,
    acks: { schedule: ack, search: ack, channels: ack, ai: ack, breakdown: ack, notify: ack, ui: ack },
    requests: [],
    aiRun: null,
    ...extra,
  };
}

describe("ageParts", () => {
  it("picks the largest unit that fits", () => {
    expect(ageParts(0)).toEqual({ unit: "seconds", count: 0 });
    expect(ageParts(59)).toEqual({ unit: "seconds", count: 59 });
    expect(ageParts(60)).toEqual({ unit: "minutes", count: 1 });
    expect(ageParts(7300)).toEqual({ unit: "hours", count: 2 });
    expect(ageParts(200_000)).toEqual({ unit: "days", count: 2 });
    expect(ageParts(-5)).toEqual({ unit: "seconds", count: 0 });
  });
});

describe("ackState", () => {
  const ack = { hash: "abc", loadedAt: NOW };
  it("is loaded only when the runner reported exactly the file on disk", () => {
    expect(ackState("abc", ack)).toBe("loaded");
    expect(ackState("def", ack)).toBe("waiting");
    expect(ackState(null, ack)).toBe("waiting");
    expect(ackState("abc", null)).toBe("unknown");
  });
});

describe("heartbeatView", () => {
  it("counts the runner as online within three heartbeat intervals", () => {
    expect(heartbeatView(null, NOW)).toEqual({ at: null, ageSeconds: null, online: false });
    expect(heartbeatView(new Date(NOW.getTime() - 89_000), NOW)).toMatchObject({ ageSeconds: 89, online: true });
    expect(heartbeatView(new Date(NOW.getTime() - 91_000), NOW)).toMatchObject({ ageSeconds: 91, online: false });
  });
});

describe("statusNeedsPolling", () => {
  const request = (state: "pending" | "running" | "done" | "failed") => ({
    id: 1,
    kind: "run_cycle" as const,
    status: state,
    requestedAt: NOW.toISOString(),
    startedAt: null,
    finishedAt: null,
    channelIds: null,
    jobIds: null,
    error: null,
    scored: null,
    failed: null,
    placeholder: false,
    cycle: null,
  });
  it("polls while a request is open or a live runner has not loaded a saved file", () => {
    expect(statusNeedsPolling(status())).toBe(false);
    expect(statusNeedsPolling(status({ requests: [request("done"), request("failed")] }))).toBe(false);
    expect(statusNeedsPolling(status({ requests: [request("pending")] }))).toBe(true);
    expect(statusNeedsPolling(status({ requests: [request("running")] }))).toBe(true);
    const waiting = { state: "waiting" as const, loadedAt: null };
    const base = status();
    expect(statusNeedsPolling({ ...base, acks: { ...base.acks, ai: waiting } })).toBe(true);
    // an offline runner will not answer: no point in asking again and again
    expect(statusNeedsPolling({ ...base, heartbeat: { at: null, ageSeconds: null, online: false }, acks: { ...base.acks, ai: waiting } })).toBe(false);
  });

  it("the response schema accepts what the server builds and rejects junk", () => {
    expect(controlStatusSchema.safeParse(status()).success).toBe(true);
    expect(controlStatusSchema.safeParse({ now: "yesterday" }).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { computeHeartbeatAgeSeconds, shapeHealth } from "@/lib/health";

const now = new Date("2026-01-01T12:00:00.000Z");

describe("computeHeartbeatAgeSeconds", () => {
  it("returns null without a heartbeat", () => {
    expect(computeHeartbeatAgeSeconds(null, now)).toBeNull();
  });

  it("returns whole elapsed seconds, rounded down", () => {
    expect(computeHeartbeatAgeSeconds(new Date("2026-01-01T11:59:30.900Z"), now)).toBe(29);
    expect(computeHeartbeatAgeSeconds(new Date("2026-01-01T11:00:00.000Z"), now)).toBe(3600);
  });

  it("clamps clock skew (heartbeat in the future) to zero", () => {
    expect(computeHeartbeatAgeSeconds(new Date("2026-01-01T12:00:05.000Z"), now)).toBe(0);
  });
});

describe("shapeHealth", () => {
  it("is 200 with db ok and heartbeat details", () => {
    const result = shapeHealth({ dbOk: true, lastHeartbeatAt: new Date("2026-01-01T11:59:45.000Z"), now });
    expect(result).toEqual({
      status: 200,
      body: { db: "ok", lastHeartbeatAt: "2026-01-01T11:59:45.000Z", heartbeatAgeSeconds: 15 },
    });
  });

  it("stays 200 when the db is ok but no runner heartbeat exists yet", () => {
    expect(shapeHealth({ dbOk: true, lastHeartbeatAt: null, now })).toEqual({
      status: 200,
      body: { db: "ok", lastHeartbeatAt: null, heartbeatAgeSeconds: null },
    });
  });

  it("is 503 and hides heartbeat data when the db is down", () => {
    expect(shapeHealth({ dbOk: false, lastHeartbeatAt: new Date("2026-01-01T11:59:45.000Z"), now })).toEqual({
      status: 503,
      body: { db: "error", lastHeartbeatAt: null, heartbeatAgeSeconds: null },
    });
  });
});

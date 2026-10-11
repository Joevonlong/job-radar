// @vitest-environment node
import { describe, expect, it } from "vitest";

import { evaluateHeartbeat } from "@/lib/ops/runner-health";

const now = new Date("2026-10-07T12:00:00Z");
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

describe("evaluateHeartbeat", () => {
  it("is healthy while the newest heartbeat is within the limit", () => {
    expect(evaluateHeartbeat({ lastHeartbeatAt: ago(5), now, maxAgeSeconds: 120 })).toMatchObject({ healthy: true, ageSeconds: 5, reason: "ok" });
    expect(evaluateHeartbeat({ lastHeartbeatAt: ago(120), now, maxAgeSeconds: 120 }).healthy).toBe(true);
  });

  it("turns unhealthy once the heartbeat is older than the limit", () => {
    const health = evaluateHeartbeat({ lastHeartbeatAt: ago(121), now, maxAgeSeconds: 120 });
    expect(health).toMatchObject({ healthy: false, ageSeconds: 121, reason: "heartbeat too old", maxAgeSeconds: 120 });
    expect(health.lastHeartbeatAt).toBe(ago(121).toISOString());
  });

  it("is unhealthy without any heartbeat", () => {
    expect(evaluateHeartbeat({ lastHeartbeatAt: null, now, maxAgeSeconds: 120 })).toMatchObject({
      healthy: false,
      lastHeartbeatAt: null,
      ageSeconds: null,
      reason: "no heartbeat",
    });
  });

  it("treats a heartbeat from the future (clock skew) as fresh", () => {
    expect(evaluateHeartbeat({ lastHeartbeatAt: ago(-30), now, maxAgeSeconds: 120 })).toMatchObject({ healthy: true, ageSeconds: 0 });
  });
});

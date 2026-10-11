// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createHeartbeatWatchdog } from "@/lib/ops/heartbeat-watchdog";

describe("createHeartbeatWatchdog", () => {
  it("asks for an exit only after failures that last as long as the healthcheck tolerates", () => {
    let t = 1_000_000;
    const dog = createHeartbeatWatchdog({ maxFailureSeconds: 120, now: () => t });
    expect(dog.failed()).toBe(false);
    t += 119_000;
    expect(dog.failed()).toBe(false);
    t += 1_000;
    expect(dog.failed()).toBe(true);
  });
  it("starts over after a successful heartbeat", () => {
    let t = 0;
    const dog = createHeartbeatWatchdog({ maxFailureSeconds: 60, now: () => t });
    dog.failed();
    t += 50_000;
    dog.succeeded();
    t += 50_000;
    expect(dog.failed()).toBe(false);
    t += 59_000;
    expect(dog.failed()).toBe(false);
    t += 1_000;
    expect(dog.failed()).toBe(true);
  });
});

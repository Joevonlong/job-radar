// @vitest-environment node
import { describe, expect, it } from "vitest";

import { configRegistry } from "@/lib/config";

import { shippedYaml } from "./helpers";

/** schedule.yaml `partial_cycle_wait`: how a scheduled cycle waits for a running cycle of some channels, a schema default only. */
const schema = configRegistry.schedule.schema;
const withWait = (partial_cycle_wait: unknown): Record<string, unknown> => ({ ...shippedYaml("schedule.yaml"), partial_cycle_wait });

describe("schedule.yaml partial_cycle_wait", () => {
  it("defaults to a 60 min wait, trying every 15 s, without the block", () => {
    const raw = shippedYaml("schedule.yaml");
    delete raw.partial_cycle_wait;
    expect(schema.parse(raw).partial_cycle_wait).toEqual({ max_minutes: 60, poll_seconds: 15 });
  });

  it("accepts 0 minutes (do not wait)", () => {
    expect(schema.parse(withWait({ max_minutes: 0, poll_seconds: 5 })).partial_cycle_wait).toEqual({ max_minutes: 0, poll_seconds: 5 });
  });

  it.each([
    [{ max_minutes: -1, poll_seconds: 5 }, "partial_cycle_wait.max_minutes"],
    [{ max_minutes: 1.5, poll_seconds: 5 }, "partial_cycle_wait.max_minutes"],
    [{ max_minutes: 10, poll_seconds: 0 }, "partial_cycle_wait.poll_seconds"],
    [{ max_minutes: 10 }, "partial_cycle_wait.poll_seconds"],
    [{ max_minutes: 10, poll_seconds: 5, extra: true }, "partial_cycle_wait"],
  ])("refuses %j, on %s", (value, path) => {
    const result = schema.safeParse(withWait(value));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toContain(path);
  });

  it("is not active in the shipped schedule.yaml (schema default only)", () => {
    expect(Object.keys(shippedYaml("schedule.yaml"))).not.toContain("partial_cycle_wait");
  });
});

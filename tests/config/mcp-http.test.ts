import { describe, expect, it } from "vitest";

import { mcpSchema } from "@/lib/config/schemas/mcp";

const defaults = {
  enabled: false, max_body_bytes: 262144,
  pool: { read_max: 3, write_max: 2, max_concurrent: 8 },
  throttle: { max_failures: 5, window_minutes: 10, lockout_minutes: 15, global_max_failures: 50, global_delay_seconds: 2 },
};

describe("HTTP configuration", () => {
  it("defaults every nested key in old and partial configurations", () => {
    for (const input of [{}, { http: {} }, { http: { pool: {}, throttle: {} } }]) expect(mcpSchema.parse(input).http).toEqual(defaults);
    expect(mcpSchema.parse({ http: { pool: { read_max: 9 } } }).http).toEqual({ ...defaults, pool: { ...defaults.pool, read_max: 9 } });
  });
  it.each([
    ["max_body_bytes", 1024, 4194304], ["pool.read_max", 1, 20], ["pool.write_max", 1, 10], ["pool.max_concurrent", 1, 64],
    ["throttle.max_failures", 1, 100], ["throttle.window_minutes", 1, 1440], ["throttle.lockout_minutes", 1, 1440],
    ["throttle.global_max_failures", 1, 10000], ["throttle.global_delay_seconds", 1, 3600],
  ] as const)("bounds integer %s", (key, min, max) => {
    const value = (n: number) => {
      const [parent, child] = key.split(".");
      return { http: child ? { [parent!]: { [child]: n } } : { [parent!]: n } };
    };
    for (const n of [min, max]) expect(mcpSchema.safeParse(value(n)).success).toBe(true);
    for (const n of [min - 1, max + 1, min + 0.5]) expect(mcpSchema.safeParse(value(n)).success).toBe(false);
  });
  it.each([{ surprise: true }, { pool: { surprise: 1 } }, { throttle: { surprise: 1 } }, { enabled: "true" }])("rejects unknown keys and wrong types: %j", (http) => {
    expect(mcpSchema.safeParse({ http }).success).toBe(false);
  });
});

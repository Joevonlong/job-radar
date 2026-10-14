// @vitest-environment node
import { describe, expect, it } from "vitest";

import { configRegistry } from "@/lib/config";

import { shippedYaml } from "./helpers";

/** schedule.yaml `logging.level`: the processes' log level, a schema default only. */
const schema = configRegistry.schedule.schema;
const withLogging = (logging: unknown): Record<string, unknown> => ({ ...shippedYaml("schedule.yaml"), logging });

describe("schedule.yaml logging.level", () => {
  it("defaults to info without a logging block and with an empty one", () => {
    const raw = shippedYaml("schedule.yaml");
    delete raw.logging;
    expect(schema.parse(raw).logging).toEqual({ level: "info" });
    expect(schema.parse(withLogging({})).logging).toEqual({ level: "info" });
  });

  it.each(["debug", "info", "warn", "error"])("accepts %s", (level) => {
    expect(schema.parse(withLogging({ level })).logging.level).toBe(level);
  });

  it.each(["verbose", "DEBUG", "", 1, null])("refuses %j, on that key", (level) => {
    const result = schema.safeParse(withLogging({ level }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toContain("logging.level");
  });

  it("refuses unknown keys in the block", () => {
    expect(schema.safeParse(withLogging({ level: "info", format: "json" })).success).toBe(false);
  });

  it("is not written into the shipped schedule.yaml (schema default only)", () => {
    expect(Object.keys(shippedYaml("schedule.yaml"))).not.toContain("logging");
  });
});

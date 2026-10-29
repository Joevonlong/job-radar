// @vitest-environment node
import fs from "node:fs";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { configRegistry } from "@/lib/config/registry";
import { activityLogSchema } from "@/lib/config/schemas/activity-log";
import { parseConfigText } from "@/lib/config/load";
import { activitySettings } from "../activity/helpers";

describe("activity log configuration", () => {
  it("accepts repository and fixture YAML without depending on their values", () => {
    for (const file of ["config/activity-log.yaml", "tests/fixtures/config/defaults/activity-log.yaml"]) {
      const text = fs.readFileSync(file, "utf8");
      expect(activityLogSchema.safeParse(YAML.parse(text)).success).toBe(true);
      expect(() => parseConfigText("activityLog", text)).not.toThrow();
    }
    expect(configRegistry.activityLog.kind).toBe("shipped");
  });
  it("accepts a complete test-owned YAML and has no implicit defaults", () => {
    expect(activityLogSchema.parse(YAML.parse(YAML.stringify(activitySettings())))).toEqual(activitySettings());
    expect(activityLogSchema.safeParse({}).success).toBe(false);
  });
  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid integer bounds: %s", (value) => {
    const input = activitySettings();
    input.retention.days = value;
    expect(activityLogSchema.safeParse(input).success).toBe(false);
  });
  it("rejects unknown nested keys, missing tuning, batch overflow and an insufficient deadline", () => {
    const base = activitySettings();
    expect(activityLogSchema.safeParse({ ...base, capture: { ...base.capture, unknown: 1 } }).success).toBe(false);
    expect(activityLogSchema.safeParse({ ...base, writer: {} }).success).toBe(false);
    expect(activityLogSchema.safeParse({ ...base, writer: { ...base.writer, batch_size: base.writer.queue_max + 1 } }).success).toBe(false);
    expect(activityLogSchema.safeParse({ ...base, writer: { ...base.writer, flush_deadline_ms: base.writer.statement_timeout_ms } }).success).toBe(false);
  });
});

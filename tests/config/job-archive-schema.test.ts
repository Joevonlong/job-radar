// @vitest-environment node
import fs from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { parseConfigText } from "@/lib/config";
import { configRegistry } from "@/lib/config/registry";
import { jobArchiveSchema } from "@/lib/config/schemas/job-archive";

const settings = () => ({ relist: { min_gap_days: 8, badge_days: 3 } });

describe("job archive configuration", () => {
  it("accepts shipped and fixture YAML without asserting their values", () => {
    for (const file of ["config/job-archive.yaml", "tests/fixtures/config/defaults/job-archive.yaml"]) {
      const text = fs.readFileSync(file, "utf8");
      expect(jobArchiveSchema.safeParse(parse(text)).success).toBe(true);
      expect(() => parseConfigText("jobArchive", text)).not.toThrow();
    }
    expect(configRegistry.jobArchive).toMatchObject({ kind: "shipped", location: "config" });
  });
  it.each([{}, { relist: {} }, { relist: { min_gap_days: 1 } }, { relist: { badge_days: 1 } },
    { ...settings(), unknown: 1 }, { relist: { ...settings().relist, unknown: 1 } }])("rejects missing and unknown keys: %j", (input) => {
    expect(jobArchiveSchema.safeParse(input).success).toBe(false);
  });
  it.each([-1, 3651, 1.5, Infinity])("rejects min_gap_days %s", (min_gap_days) => {
    expect(jobArchiveSchema.safeParse({ relist: { ...settings().relist, min_gap_days } }).success).toBe(false);
  });
  it.each([0, -1, 366, 1.5, Infinity])("rejects badge_days %s", (badge_days) => {
    expect(jobArchiveSchema.safeParse({ relist: { ...settings().relist, badge_days } }).success).toBe(false);
  });
  it("accepts inclusive bounds without filling defaults", () => {
    for (const relist of [{ min_gap_days: 0, badge_days: 1 }, { min_gap_days: 3650, badge_days: 365 }]) {
      expect(jobArchiveSchema.parse({ relist })).toEqual({ relist });
    }
  });
});

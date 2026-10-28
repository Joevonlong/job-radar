// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { configRegistry } from "@/lib/config";

import { shippedPipelineFile } from "../pipeline/helpers";

describe("dormancy configuration", () => {
  it("supplies thirty days when the key is missing", () => {
    const config = shippedPipelineFile((raw) => {
      delete (raw.lifecycle as Record<string, unknown>).dormant_after_days;
    });
    expect(config.lifecycle.dormant_after_days).toBe(30);
  });

  it.each([0, 3650])("accepts the boundary %s", (days) => {
    expect(shippedPipelineFile((raw) => { (raw.lifecycle as Record<string, unknown>).dormant_after_days = days; }).lifecycle.dormant_after_days).toBe(days);
  });

  it.each([-1, 1.5, 3651])("refuses %s", (days) => {
    expect(() => shippedPipelineFile((raw) => { (raw.lifecycle as Record<string, unknown>).dormant_after_days = days; })).toThrow();
  });

  it("keeps the shipped file valid without persisting the optional key", () => {
    const raw = parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../config/pipeline.yaml"), "utf8")) as Record<string, unknown>;
    const { config_version: version, ...file } = raw;
    void version;
    expect(configRegistry.pipeline.schema.safeParse(file).success).toBe(true);
    expect(file.lifecycle).not.toHaveProperty("dormant_after_days");
  });
});

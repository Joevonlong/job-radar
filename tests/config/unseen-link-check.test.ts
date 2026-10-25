// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { configRegistry, parseConfigText } from "@/lib/config";

import { pipelineWith, shippedPipelineFile } from "../pipeline/helpers";
import { shippedYaml } from "./helpers";

describe("unseen jobs' link check configuration", () => {
  it("defaults missing keys to 14 days unseen and 7 days between checks", () => {
    const config = shippedPipelineFile((raw) => {
      const lifecycle = raw.lifecycle as Record<string, unknown>;
      delete lifecycle.unseen_link_check_after_days;
      delete lifecycle.unseen_link_check_interval_days;
    });
    expect(config.lifecycle).toMatchObject({ unseen_link_check_after_days: 14, unseen_link_check_interval_days: 7 });
  });

  it("accepts the shipped file without activating either key", () => {
    // Only check the file's schema and key presence, never its tunable values.
    const raw = parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../config/pipeline.yaml"), "utf8")) as Record<string, unknown>;
    const { config_version: version, ...file } = raw;
    void version;
    expect(configRegistry.pipeline.schema.safeParse(file).success).toBe(true);
    expect(file.lifecycle).not.toHaveProperty("unseen_link_check_after_days");
    expect(file.lifecycle).not.toHaveProperty("unseen_link_check_interval_days");
  });

  it("allows switching the fallback off independently of possibly-closed timing", () => {
    const config = pipelineWith((raw) => {
      const lifecycle = raw.lifecycle as Record<string, unknown>;
      lifecycle.possibly_closed_after_days = 30;
      lifecycle.unseen_link_check_after_days = 0;
      lifecycle.unseen_link_check_interval_days = 1;
    });
    expect(config.lifecycle.unseen_link_check_after_days).toBe(0);
  });

  it.each([
    ["unseen_link_check_after_days", -1, "Too small: expected number to be >=0"],
    ["unseen_link_check_after_days", 366, "Too big: expected number to be <=365"],
    ["unseen_link_check_after_days", 1.5, "Invalid input: expected int, received number"],
    ["unseen_link_check_interval_days", 0, "Too small: expected number to be >=1"],
    ["unseen_link_check_interval_days", 366, "Too big: expected number to be <=365"],
    ["unseen_link_check_interval_days", 1.5, "Invalid input: expected int, received number"],
  ])("rejects %s = %s", (key, value, problem) => {
    const raw = shippedYaml("pipeline.yaml");
    (raw.lifecycle as Record<string, unknown>)[key] = value;
    expect(() => parseConfigText("pipeline", stringify(raw), "pipeline.yaml")).toThrow(`lifecycle.${key}: ${problem}`);
  });

  it.each([
    ["unseen_link_check_after_days", 0],
    ["unseen_link_check_after_days", 365],
    ["unseen_link_check_interval_days", 1],
    ["unseen_link_check_interval_days", 365],
  ])("loads the boundary %s = %s", (key, value) => {
    const raw = shippedYaml("pipeline.yaml");
    (raw.lifecycle as Record<string, unknown>)[key] = value;
    expect(parseConfigText("pipeline", stringify(raw), "pipeline.yaml").lifecycle).toHaveProperty(key, value);
  });
});

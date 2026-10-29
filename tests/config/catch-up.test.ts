// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { loadConfig } from "@/lib/config";
import { channelsSchema, MAX_WINDOW_HOURS } from "@/lib/config/schemas/channels";

import { makeTempConfig, REPO_DEFAULTS_DIR, shippedYaml, type TempConfig } from "./helpers";

let tmp: TempConfig;
beforeEach(() => { tmp = makeTempConfig(); });
afterEach(() => tmp.cleanup());

function writeCollect(value: unknown): void {
  const file = path.join(tmp.configDir, "sources.yaml");
  const doc = parseDocument(fs.readFileSync(file, "utf8"));
  if (value === undefined) doc.delete("collect");
  else doc.set("collect", doc.createNode(value));
  fs.writeFileSync(file, doc.toString());
}

describe("catch-up configuration compatibility", () => {
  it.each([undefined, { concurrency: 2, query_rotation: false }])("loads an old user file with collect=%j using catch-up defaults", (collect) => {
    writeCollect(collect);
    expect(loadConfig("channels").collect).toMatchObject({ max_catch_up_hours: 168, catch_up_tolerance_hours: 6 });
  });

  it("exports the shared maximum window", () => {
    expect(MAX_WINDOW_HOURS).toBe(720);
  });

  it.each([
    { max_catch_up_hours: 0, catch_up_tolerance_hours: 0 },
    { max_catch_up_hours: 720, catch_up_tolerance_hours: 72 },
    { max_catch_up_hours: 1, catch_up_tolerance_hours: 6 },
  ])("loads valid boundary values %j without cross-validating against base windows", (collect) => {
    writeCollect(collect);
    expect(loadConfig("channels").collect).toMatchObject(collect);
  });

  it.each([
    ["max_catch_up_hours", 721],
    ["max_catch_up_hours", -1],
    ["max_catch_up_hours", 1.5],
    ["catch_up_tolerance_hours", 73],
    ["catch_up_tolerance_hours", -1],
    ["catch_up_tolerance_hours", 1.5],
  ])("rejects %s=%s at that field", (key, value) => {
    const result = channelsSchema.safeParse({ ...shippedYaml("sources.yaml"), collect: { [key]: value } });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(["collect", key]);
  });

  it("keeps the shipped sources file strict-schema compatible with no active catch-up keys", () => {
    // Validate packaging only: defaults and boundary values above come from test-owned files.
    const doc = parseDocument(fs.readFileSync(path.join(REPO_DEFAULTS_DIR, "sources.yaml"), "utf8"));
    expect(doc.errors).toEqual([]);
    expect(doc.hasIn(["collect", "max_catch_up_hours"])).toBe(false);
    expect(doc.hasIn(["collect", "catch_up_tolerance_hours"])).toBe(false);
    doc.delete("config_version");
    expect(channelsSchema.safeParse(doc.toJS()).success).toBe(true);
  });
});

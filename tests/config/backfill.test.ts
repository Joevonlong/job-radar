// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { channelsSchema } from "@/lib/config/schemas/channels";

import { REPO_DEFAULTS_DIR, shippedYaml } from "./helpers";

describe("manual backfill configuration", () => {
  it.each([undefined, { concurrency: 2 }])("defaults the limit for collect=%j", (collect) => {
    expect(channelsSchema.parse({ ...shippedYaml("sources.yaml"), collect }).collect.max_backfill_hours).toBe(168);
  });

  it.each([1, 720])("accepts a limit of %s hours independently of catch-up", (hours) => {
    const collect = { max_backfill_hours: hours, max_catch_up_hours: 0 };
    expect(channelsSchema.parse({ ...shippedYaml("sources.yaml"), collect }).collect.max_backfill_hours).toBe(hours);
  });

  it.each([0, 721, 1.5])("rejects a limit of %s hours", (hours) => {
    const result = channelsSchema.safeParse({ ...shippedYaml("sources.yaml"), collect: { max_backfill_hours: hours } });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(["collect", "max_backfill_hours"]);
  });

  it("ships the backfill limit as a comment only", () => {
    const doc = parseDocument(fs.readFileSync(path.join(REPO_DEFAULTS_DIR, "sources.yaml"), "utf8"));
    expect(doc.errors).toEqual([]);
    expect(doc.hasIn(["collect", "max_backfill_hours"])).toBe(false);
    doc.delete("config_version");
    expect(channelsSchema.safeParse(doc.toJS()).success).toBe(true);
  });
});

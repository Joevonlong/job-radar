// @vitest-environment node
import { describe, expect, it } from "vitest";

import { configRegistry } from "@/lib/config";

import { shippedYaml } from "./helpers";

const parse = (edit: (raw: Record<string, unknown>) => void) => {
  const raw = structuredClone(shippedYaml("breakdown.yaml"));
  edit(raw);
  return configRegistry.breakdown.schema.safeParse(raw);
};
const problems = (edit: (raw: Record<string, unknown>) => void): string[] => {
  const result = parse(edit);
  return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
};

describe("breakdown.yaml schema", () => {
  it("the shipped file is valid, off and manual", () => {
    const result = parse(() => {});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.mode).toBe("manual");
    }
  });

  it("rejects an unknown mode, an out-of-range rank, a bad head share and extra keys", () => {
    expect(problems((raw) => { raw.mode = "sometimes"; })).toEqual(["mode"]);
    expect(problems((raw) => { (raw.auto as Record<string, unknown>).min_rank = 120; })).toEqual(["auto.min_rank"]);
    expect(problems((raw) => { raw.jd_head_share = 0.95; })).toEqual(["jd_head_share"]);
    expect(problems((raw) => { raw.typo = 1; })).toEqual([""]);
    expect(problems((raw) => { (raw.auto as Record<string, unknown>).extra = 1; })).toEqual(["auto"]);
    expect(problems((raw) => { raw.timeout_seconds = 0; })).toEqual(["timeout_seconds"]);
    expect(problems((raw) => { raw.jd_max_chars = 100; })).toEqual(["jd_max_chars"]);
  });
});

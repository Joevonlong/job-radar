// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { parseConfigText } from "@/lib/config";
import { checkCommentedDefaults, TITLE_GUARD_BLOCK } from "@/lib/config/commented-defaults";
import { titleGuardSchema } from "@/lib/config/schemas/pipeline";

import { makeTempConfig, type TempConfig } from "./helpers";
import { runConfigScript } from "./run-script";

const LEGACY = path.resolve(import.meta.dirname, "../fixtures/config/legacy-de/pipeline.yaml");

describe("dedupe.title_guard", () => {
  it("takes the schema's defaults in an older whole file without it", () => {
    const parsed = parseConfigText("pipeline", fs.readFileSync(LEGACY, "utf8"), "pipeline.yaml");
    expect(parsed.dedupe.title_guard).toEqual(titleGuardSchema.parse({}));
  });

  it.each([
    ["a bad regular expression", { ignore_patterns: ["("] }],
    ["a same-title limit out of range", { same_title_max_distance: 65 }],
    ["a negative same-title limit", { same_title_max_distance: -1 }],
    ["a different-title limit out of range", { different_title_max_distance: 65 }],
    ["a synonym key of two words", { synonyms: { "machine learning": "ml" } }],
    ["an unknown key", { enabled_for: true }],
  ])("refuses %s", (_name, guard) => {
    expect(titleGuardSchema.safeParse(guard).success).toBe(false);
  });
});

describe("the commented defaults block", () => {
  const schema = z.strictObject({ on: z.boolean().default(true), limit: z.number().default(5), words: z.array(z.string()).default(["a", "b"]) });
  const shape = { start: "  # >>> demo defaults", end: "  # <<< demo defaults", prefix: "  # " };
  const body = ["  # demo:", "  #   on: true", "  #   limit: 5", "  #   words: [a, b]"];
  const file = (lines: readonly string[]): string => ["top: 1", "dedupe:", ...lines, "after: 2", ""].join("\n");
  const wrapped = (lines: readonly string[]): string => file([shape.start, ...lines, shape.end]);
  const check = (text: string) => checkCommentedDefaults(text, shape, "demo", schema);

  it("passes when it equals the schema's defaults", () => {
    expect(check(wrapped(body))).toMatchObject({ ok: true, value: { demo: { on: true, limit: 5, words: ["a", "b"] } } });
  });

  it.each([
    ["a value that differs", wrapped(["  # demo:", "  #   on: true", "  #   limit: 6", "  #   words: [a, b]"]), /limit is 6/, 3],
    ["a missing field", wrapped(["  # demo:", "  #   on: true", "  #   words: [a, b]"]), /missing key limit/, 3],
    ["an extra field", wrapped([...body, "  #   more: 1"]), /unknown key more/, 3],
    ["a missing start marker", file([...body, shape.end]), /missing start marker/, 1],
    ["a missing end marker", file([shape.start, ...body]), /missing end marker/, 3],
    ["the markers in the wrong order", file([shape.end, ...body, shape.start]), /end marker before start marker/, 3],
    ["a note without the prefix", wrapped([...body, "note in between"]), /does not start with/, 8],
    ["a note with the prefix", wrapped(["  # note in between", ...body]), /not valid YAML|must be a mapping|one key/, 3],
  ])("fails on %s, with the reason and the line", (_name, text, reason, line) => {
    const result = check(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(reason);
    expect(result.line).toBeGreaterThanOrEqual(line);
  });

  it("has the shape of the title_guard block", () => {
    expect(TITLE_GUARD_BLOCK.start.startsWith(TITLE_GUARD_BLOCK.prefix)).toBe(true);
    expect(TITLE_GUARD_BLOCK.end.startsWith(TITLE_GUARD_BLOCK.prefix)).toBe(true);
  });
});

describe("pnpm config:check on the title guard", () => {
  let tmp: TempConfig;
  beforeEach(() => {
    tmp = makeTempConfig();
  });
  afterEach(() => tmp.cleanup());

  const withDedupe = (lines: string): void => {
    const file = path.join(tmp.configDir, "pipeline.yaml");
    const shipped = fs.readFileSync(path.join(tmp.defaultsDir, "pipeline.yaml"), "utf8");
    fs.writeFileSync(file, shipped.replace(/^dedupe:\n/m, `dedupe:\n${lines}\n`));
  };

  it("warns about a same-title limit below the compatible limit", () => {
    withDedupe("  title_guard:\n    same_title_max_distance: 1");
    expect(runConfigScript(tmp, "config-check.ts", []).out).toMatch(/same_title_max_distance \(1\) is below/);
  });

  it("warns about a same-title limit above the related-company limit", () => {
    withDedupe("  title_guard:\n    same_title_max_distance: 40");
    expect(runConfigScript(tmp, "config-check.ts", []).out).toMatch(/same_title_max_distance \(40\) is above/);
  });

  it("fails when the shipped block has drifted", () => {
    const file = path.join(tmp.defaultsDir, "pipeline.yaml");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/  # >>> title_guard defaults[\s\S]*?  # <<< title_guard defaults\n/, ""));
    const run = runConfigScript(tmp, "config-check.ts", []);
    expect(run.status).not.toBe(0);
    expect(run.out).toMatch(/title_guard commented defaults: missing start marker/);
  });
});

// @vitest-environment node
/**
 * sources.yaml 2 -> 3 (the Arbeitnow channel block) and pipeline.yaml 2 -> 3 (its family in apply_priority): placement,
 * values, comments, idempotence and the in-memory load of a user file that has neither.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse, parseDocument } from "yaml";

import { migrateConfigDocument, parseConfigDocument, validateConfigValue, type ConfigName } from "@/lib/config";
import { pipeline003 } from "@/lib/config/migrations/pipeline/003-arbeitnow-priority";
import { sources003 } from "@/lib/config/migrations/sources/003-arbeitnow";

import { FIXTURE_DEFAULTS_DIR } from "./helpers";

const SERIALIZE = { lineWidth: 0, flowCollectionPadding: false } as const;

function migrate(name: ConfigName, text: string): { text: string; steps: number } {
  const doc = parseConfigDocument(name, text, "test.yaml");
  const result = migrateConfigDocument(name, doc, "test.yaml");
  return { text: doc.toString(SERIALIZE), steps: result.applied.length };
}

/** A v2 file: the fixture snapshot without what step 3 adds. */
function v2(file: "sources.yaml" | "pipeline.yaml", drop: readonly string[]): string {
  const doc = parseDocument(fs.readFileSync(path.join(FIXTURE_DEFAULTS_DIR, file), "utf8"));
  doc.deleteIn(drop);
  doc.set("config_version", 2);
  return doc.toString(SERIALIZE);
}

const SMALL_V2 = `config_version: 2
# my channels
sources:
  greenhouse:
    enabled: true
    title_prefilter:
      enabled: true
      include_terms: [Data]
      # my own exclusions
      exclude_terms: [Junior]
  stepstone:
    enabled: false # off for now
  xing:
    enabled: false
  lever:
    enabled: true
`;

describe("sources.yaml 2 -> 3", () => {
  it("brings a v2 file to what the shipped defaults hold, and it validates", () => {
    const { text, steps } = migrate("channels", v2("sources.yaml", ["sources", "arbeitnow"]));
    expect(steps).toBe(1);
    expect(text).toMatch(/^config_version: 3$/m);
    const shipped = parse(fs.readFileSync(path.join(FIXTURE_DEFAULTS_DIR, "sources.yaml"), "utf8")) as Record<string, unknown>;
    expect(parse(text)).toEqual(shipped);
    const value = validateConfigValue("channels", parse(text), "sources.yaml");
    expect(value.sources.arbeitnow).toMatchObject({ enabled: true, markets: ["DE"], max_pages: 8, monthly_budget_usd: 0 });
  });

  it("adds the block after xing with an English comment, the prefilter terms copied from greenhouse", () => {
    const { text } = migrate("channels", SMALL_V2);
    const keys = Object.keys((parse(text) as { sources: Record<string, unknown> }).sources);
    expect(keys).toEqual(["greenhouse", "stepstone", "xing", "arbeitnow", "lever"]);
    const block = (parse(text) as { sources: Record<string, Record<string, unknown>> }).sources.arbeitnow;
    expect(block?.title_prefilter).toEqual({ enabled: true, include_terms: ["Data"], exclude_terms: ["Junior"] });
    const comment = text.slice(text.indexOf("xing:"), text.indexOf("  arbeitnow:"));
    expect(comment).toContain("# Arbeitnow: free public Job Board API");
    expect(comment).toContain("link back to arbeitnow.com");
    expect(comment).not.toMatch(/[　-鿿]/u);
    expect(text).toContain("markets: [DE]");
    expect(text).toContain("throttle: {min_delay_ms: 1000, max_delay_ms: 3000}");
  });

  it("keeps every comment of the file", () => {
    const { text } = migrate("channels", SMALL_V2);
    for (const comment of ["# my channels", "# my own exclusions", "# off for now"]) expect(text).toContain(comment);
  });

  it("uses the default prefilter terms when greenhouse has none, and goes last without a German board", () => {
    const { text } = migrate("channels", "config_version: 2\nsources:\n  lever:\n    enabled: true\n");
    const sources = (parse(text) as { sources: Record<string, Record<string, unknown>> }).sources;
    expect(Object.keys(sources)).toEqual(["lever", "arbeitnow"]);
    expect(sources.arbeitnow?.title_prefilter).toMatchObject({ include_terms: [], exclude_terms: expect.arrayContaining(["Werkstudent", "Internship"]) });
  });

  it("is idempotent: a second run changes nothing, and an existing block is left alone", () => {
    const once = migrate("channels", SMALL_V2).text;
    expect(migrate("channels", once)).toEqual({ text: once, steps: 0 });
    const own = SMALL_V2.replace("  lever:", "  arbeitnow:\n    enabled: false\n  lever:");
    const doc = parseDocument(own);
    sources003.migrate(doc);
    expect(doc.toString(SERIALIZE)).toBe(parseDocument(own).toString(SERIALIZE));
  });

  it("does nothing to a file without a sources mapping", () => {
    const doc = parseDocument("config_version: 2\nlinkedin: {}\n");
    sources003.migrate(doc);
    expect(doc.has("sources")).toBe(false);
  });
});

describe("pipeline.yaml 2 -> 3", () => {
  it("adds arbeitnow after arbeitsagentur in apply_priority, and the file validates", () => {
    const { text, steps } = migrate("pipeline", v2("pipeline.yaml", ["apply_priority", "arbeitnow"]));
    expect(steps).toBe(1);
    const value = validateConfigValue("pipeline", parse(text), "pipeline.yaml");
    expect(value.apply_priority.arbeitnow).toBe(4);
    const keys = Object.keys(value.apply_priority);
    expect(keys[keys.indexOf("arbeitsagentur") + 1]).toBe("arbeitnow");
  });

  it("is idempotent and keeps a priority the user set", () => {
    const once = migrate("pipeline", v2("pipeline.yaml", ["apply_priority", "arbeitnow"])).text;
    expect(migrate("pipeline", once)).toEqual({ text: once, steps: 0 });
    const doc = parseDocument("apply_priority:\n  arbeitsagentur: 4\n  arbeitnow: 9\n");
    pipeline003.migrate(doc);
    expect(doc.getIn(["apply_priority", "arbeitnow"])).toBe(9);
  });
});

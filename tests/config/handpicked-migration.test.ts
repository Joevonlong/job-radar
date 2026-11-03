// @vitest-environment node
/**
 * sources.yaml 4 -> 5 (the Handpicked Berlin channel block, switched off) and pipeline.yaml 3 -> 4 (its family in
 * apply_priority): placement, values, comments, idempotence and the in-memory load of a user file that has neither.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse, parseDocument } from "yaml";

import { migrateConfigDocument, parseConfigDocument, validateConfigValue, type ConfigName } from "@/lib/config";
import { pipeline004 } from "@/lib/config/migrations/pipeline/004-handpicked-priority";
import { sources005 } from "@/lib/config/migrations/sources/005-handpicked";

import { FIXTURE_DEFAULTS_DIR } from "./helpers";

const SERIALIZE = { lineWidth: 0, flowCollectionPadding: false } as const;

function migrate(name: ConfigName, text: string): { text: string; steps: number } {
  const doc = parseConfigDocument(name, text, "test.yaml");
  const result = migrateConfigDocument(name, doc, "test.yaml");
  return { text: doc.toString(SERIALIZE), steps: result.applied.length };
}

/** A v4 / v3 file: the fixture snapshot without what the step adds. */
function older(file: "sources.yaml" | "pipeline.yaml", drop: readonly string[], version: number): string {
  const doc = parseDocument(fs.readFileSync(path.join(FIXTURE_DEFAULTS_DIR, file), "utf8"));
  doc.deleteIn(drop);
  doc.set("config_version", version);
  return doc.toString(SERIALIZE);
}

const SMALL_V4 = `config_version: 4
# my channels
sources:
  greenhouse:
    enabled: true
    title_prefilter:
      enabled: true
      include_terms: [Data]
      # my own exclusions
      exclude_terms: [Junior]
  arbeitnow:
    enabled: false # off for now
  lever:
    enabled: true
`;

describe("sources.yaml 4 -> 5", () => {
  it("brings a v4 file to what the shipped defaults hold, and it validates", () => {
    const { text, steps } = migrate("channels", older("sources.yaml", ["sources", "handpicked"], 4));
    expect(steps).toBe(4); // 5 -> 6 (Berlin Design Network), 6 -> 7 (Berlin Startup Jobs) and 7 -> 8 (StepStone) follow
    expect(text).toMatch(/^config_version: 8$/m);
    const shipped = parse(fs.readFileSync(path.join(FIXTURE_DEFAULTS_DIR, "sources.yaml"), "utf8")) as Record<string, unknown>;
    expect(parse(text)).toEqual(shipped);
    const value = validateConfigValue("channels", parse(text), "sources.yaml");
    expect(value.sources.handpicked).toMatchObject({
      enabled: false,
      markets: ["DE"],
      monthly_budget_usd: 0,
      max_age_days: 14,
      max_details_per_run: 30,
      skip_known_boards: true,
      discover_boards: { enabled: true, interval_hours: 24, require_title_match: true },
    });
  });

  it("adds the block after arbeitnow with an English comment, the prefilter terms copied from greenhouse", () => {
    const { text } = migrate("channels", SMALL_V4);
    const keys = Object.keys((parse(text) as { sources: Record<string, unknown> }).sources);
    expect(keys).toEqual(["greenhouse", "arbeitnow", "berlinstartupjobs", "handpicked", "lever", "berlin_design_network"]);
    const block = (parse(text) as { sources: Record<string, Record<string, unknown>> }).sources.handpicked;
    expect(block?.title_prefilter).toEqual({ enabled: true, include_terms: ["Data"], exclude_terms: ["Junior"] });
    expect(block?.enabled).toBe(false);
    const comment = text.slice(text.indexOf("off for now"), text.indexOf("  handpicked:"));
    expect(comment).toContain("# Handpicked Berlin: the public job index");
    expect(comment).toContain("publishes no terms");
    expect(comment).not.toMatch(/[　-鿿]/u);
    expect(text).toContain("markets: [DE]");
    expect(text).toContain("throttle: {min_delay_ms: 1000, max_delay_ms: 3000}");
  });

  it("keeps every comment of the file", () => {
    const { text } = migrate("channels", SMALL_V4);
    for (const comment of ["# my channels", "# my own exclusions", "# off for now"]) expect(text).toContain(comment);
  });

  it("uses the default prefilter terms when greenhouse has none, and goes last without a German board", () => {
    const { text } = migrate("channels", "config_version: 4\nsources:\n  lever:\n    enabled: true\n");
    const sources = (parse(text) as { sources: Record<string, Record<string, unknown>> }).sources;
    expect(Object.keys(sources)).toEqual(["lever", "handpicked", "berlin_design_network", "berlinstartupjobs"]);
    expect(sources.handpicked?.title_prefilter).toMatchObject({ include_terms: [], exclude_terms: expect.arrayContaining(["Werkstudent", "Internship"]) });
  });

  it("is idempotent: a second run changes nothing, and an existing block is left alone", () => {
    const once = migrate("channels", SMALL_V4).text;
    expect(migrate("channels", once)).toEqual({ text: once, steps: 0 });
    const own = SMALL_V4.replace("  lever:", "  handpicked:\n    enabled: true\n  lever:");
    const doc = parseDocument(own);
    sources005.migrate(doc);
    expect(doc.toString(SERIALIZE)).toBe(parseDocument(own).toString(SERIALIZE));
  });

  it("does nothing to a file without a sources mapping", () => {
    const doc = parseDocument("config_version: 4\nlinkedin: {}\n");
    sources005.migrate(doc);
    expect(doc.has("sources")).toBe(false);
  });
});

describe("pipeline.yaml 3 -> 4", () => {
  it("adds handpicked after linkedin in apply_priority, and the file validates", () => {
    const { text, steps } = migrate("pipeline", older("pipeline.yaml", ["apply_priority", "handpicked"], 3));
    expect(steps).toBe(2); // 4 -> 5 (Berlin Startup Jobs) follows
    const value = validateConfigValue("pipeline", parse(text), "pipeline.yaml");
    expect(value.apply_priority.handpicked).toBe(2);
    const keys = Object.keys((parse(text) as { apply_priority: Record<string, number> }).apply_priority);
    expect(keys[keys.indexOf("linkedin") + 1]).toBe("handpicked");
  });

  it("is idempotent and keeps a priority the user set", () => {
    const once = migrate("pipeline", older("pipeline.yaml", ["apply_priority", "handpicked"], 3)).text;
    expect(migrate("pipeline", once)).toEqual({ text: once, steps: 0 });
    const doc = parseDocument("apply_priority:\n  linkedin: 2\n  handpicked: 9\n");
    pipeline004.migrate(doc);
    expect(doc.getIn(["apply_priority", "handpicked"])).toBe(9);
  });
});

// @vitest-environment node
/**
 * sources.yaml 8 -> 9: sources.stepstone loses radius_km and max_pages (its robots.txt only permits a search URL with a single q= parameter).
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse, parseDocument } from "yaml";

import { migrateConfigDocument, parseConfigDocument, validateConfigValue } from "@/lib/config";
import { sources009 } from "@/lib/config/migrations/sources/009-stepstone-robots";

import { FIXTURE_DEFAULTS_DIR } from "./helpers";

const SERIALIZE = { lineWidth: 0, flowCollectionPadding: false } as const;

function migrate(text: string): { text: string; steps: number } {
  const doc = parseConfigDocument("channels", text, "test.yaml");
  const result = migrateConfigDocument("channels", doc, "test.yaml");
  return { text: doc.toString(SERIALIZE), steps: result.applied.length };
}

/** The fixture snapshot at version 8: StepStone still has its radius and page cap. */
function v8(): string {
  const doc = parseDocument(fs.readFileSync(path.join(FIXTURE_DEFAULTS_DIR, "sources.yaml"), "utf8"));
  doc.set("config_version", 8);
  doc.setIn(["sources", "stepstone", "radius_km"], 30);
  doc.setIn(["sources", "stepstone", "max_pages"], 2);
  return doc.toString(SERIALIZE);
}

const SMALL_V8 = `config_version: 8
sources:
  stepstone:
    enabled: true # I use it
    # my own note
    radius_km: 50 # wide
    max_pages: 4
    fetch_details: false
  xing:
    enabled: false
    radius_km: 40
    max_pages: 3
`;

describe("sources.yaml 8 -> 9", () => {
  it("brings a v8 file to what the shipped defaults hold, and it validates", () => {
    const { text, steps } = migrate(v8());
    expect(steps).toBe(1);
    expect(text).toMatch(/^config_version: 9$/m);
    const shipped = parse(fs.readFileSync(path.join(FIXTURE_DEFAULTS_DIR, "sources.yaml"), "utf8")) as Record<string, unknown>;
    // the shipped file has moved on to the overlay format, which changes nothing but its version
    expect(parse(text)).toEqual({ ...shipped, config_version: 9 });
    const config = validateConfigValue("channels", parse(text), "sources.yaml");
    expect(config.sources.stepstone).not.toHaveProperty("radius_km");
    expect(config.sources.stepstone).not.toHaveProperty("max_pages");
  });

  it("removes only StepStone's two keys, keeps XING's and the user's other settings and comments", () => {
    const doc = parseDocument(SMALL_V8);
    sources009.migrate(doc);
    const text = doc.toString(SERIALIZE);
    expect(parse(text)).toEqual({
      config_version: 8,
      sources: { stepstone: { enabled: true, fetch_details: false }, xing: { enabled: false, radius_km: 40, max_pages: 3 } },
    });
    expect(text).toContain("enabled: true # I use it");
  });

  it("is idempotent and a no-op without the block", () => {
    const doc = parseDocument(SMALL_V8);
    sources009.migrate(doc);
    const once = doc.toString(SERIALIZE);
    sources009.migrate(doc);
    expect(doc.toString(SERIALIZE)).toBe(once);
    const bare = parseDocument("config_version: 8\nlinkedin: {}\n");
    sources009.migrate(bare);
    expect(bare.toString(SERIALIZE)).toBe("config_version: 8\nlinkedin: {}\n");
  });
});

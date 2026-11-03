// @vitest-environment node
/**
 * sources.yaml 6 -> 7 (the Berlin Startup Jobs channel block) and pipeline.yaml 4 -> 5 (its family in apply_priority):
 * placement, values, comments, idempotence and the load of a user file that has neither.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse, parseDocument } from "yaml";

import { migrateConfigDocument, parseConfigDocument, validateConfigValue, type ConfigName } from "@/lib/config";
import { pipeline005 } from "@/lib/config/migrations/pipeline/005-berlinstartupjobs-priority";
import { sources007 } from "@/lib/config/migrations/sources/007-berlinstartupjobs";

import { FIXTURE_DEFAULTS_DIR } from "./helpers";

const SERIALIZE = { lineWidth: 0, flowCollectionPadding: false } as const;

function migrate(name: ConfigName, text: string): { text: string; steps: number } {
  const doc = parseConfigDocument(name, text, "test.yaml");
  const result = migrateConfigDocument(name, doc, "test.yaml");
  return { text: doc.toString(SERIALIZE), steps: result.applied.length };
}

/** The fixture snapshot without what the step adds, at the version before it. */
function older(file: "sources.yaml" | "pipeline.yaml", drop: readonly string[], version: number): string {
  const doc = parseDocument(fs.readFileSync(path.join(FIXTURE_DEFAULTS_DIR, file), "utf8"));
  doc.deleteIn(drop);
  doc.set("config_version", version);
  return doc.toString(SERIALIZE);
}

const SMALL_V6 = `config_version: 6
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

describe("sources.yaml 6 -> 7", () => {
  it("brings a v6 file to what the shipped defaults hold, and it validates", () => {
    const { text, steps } = migrate("channels", older("sources.yaml", ["sources", "berlinstartupjobs"], 6));
    expect(steps).toBe(3); // 7 -> 8 (Apify exact window) and 8 -> 9 (StepStone) follow
    expect(text).toMatch(/^config_version: 9$/m);
    const shipped = parse(fs.readFileSync(path.join(FIXTURE_DEFAULTS_DIR, "sources.yaml"), "utf8")) as Record<string, unknown>;
    expect(parse(text)).toEqual(shipped);
    expect(validateConfigValue("channels", parse(text), "sources.yaml").sources.berlinstartupjobs).toMatchObject({
      enabled: true,
      markets: ["DE"],
      monthly_budget_usd: 0,
      base_url: "https://berlinstartupjobs.com",
      per_page: 100,
      max_pages: 5,
      skip_expired: true,
      max_age_days: 90,
    });
  });

  it("adds the block after arbeitnow with an English comment, the prefilter terms copied from greenhouse", () => {
    const { text } = migrate("channels", SMALL_V6);
    const parsed = parse(text) as { sources: Record<string, Record<string, unknown>> };
    expect(Object.keys(parsed.sources)).toEqual(["greenhouse", "arbeitnow", "berlinstartupjobs", "lever"]);
    expect(parsed.sources.berlinstartupjobs?.title_prefilter).toEqual({ enabled: true, include_terms: ["Data"], exclude_terms: ["Junior"] });
    const comment = text.slice(text.indexOf("off for now"), text.indexOf("  berlinstartupjobs:"));
    expect(comment).toContain("# Berlin Startup Jobs: the public WordPress REST API");
    expect(comment).toContain("robots.txt allows /wp-json/");
    expect(comment).not.toMatch(/[　-鿿]/u);
    expect(text).toContain("markets: [DE]");
    for (const kept of ["# my channels", "# my own exclusions", "# off for now"]) expect(text).toContain(kept);
  });

  it("uses the default prefilter terms when greenhouse has none, and goes last without a German board", () => {
    const { text } = migrate("channels", "config_version: 6\nsources:\n  lever:\n    enabled: true\n");
    const sources = (parse(text) as { sources: Record<string, Record<string, unknown>> }).sources;
    expect(Object.keys(sources)).toEqual(["lever", "berlinstartupjobs"]);
    expect(sources.berlinstartupjobs?.title_prefilter).toMatchObject({ include_terms: [], exclude_terms: expect.arrayContaining(["Werkstudent", "Internship"]) });
  });

  it("is idempotent, leaves an existing block alone, and ignores a file without sources", () => {
    const once = migrate("channels", SMALL_V6).text;
    expect(migrate("channels", once)).toEqual({ text: once, steps: 0 });
    const own = SMALL_V6.replace("  lever:", "  berlinstartupjobs:\n    enabled: false\n  lever:");
    const doc = parseDocument(own);
    sources007.migrate(doc);
    expect(doc.toString(SERIALIZE)).toBe(parseDocument(own).toString(SERIALIZE));
    const bare = parseDocument("config_version: 6\nlinkedin: {}\n");
    sources007.migrate(bare);
    expect(bare.has("sources")).toBe(false);
  });
});

describe("pipeline.yaml 4 -> 5", () => {
  it("adds berlinstartupjobs after indeed in apply_priority, and the file validates", () => {
    const { text, steps } = migrate("pipeline", older("pipeline.yaml", ["apply_priority", "berlinstartupjobs"], 4));
    expect(steps).toBe(1);
    const value = validateConfigValue("pipeline", parse(text), "pipeline.yaml");
    expect(value.apply_priority.berlinstartupjobs).toBe(3);
    const keys = Object.keys((parse(text) as { apply_priority: Record<string, number> }).apply_priority);
    expect(keys[keys.indexOf("indeed") + 1]).toBe("berlinstartupjobs");
  });

  it("is idempotent and keeps a priority the user set", () => {
    const once = migrate("pipeline", older("pipeline.yaml", ["apply_priority", "berlinstartupjobs"], 4)).text;
    expect(migrate("pipeline", once)).toEqual({ text: once, steps: 0 });
    const doc = parseDocument("apply_priority:\n  indeed: 3\n  berlinstartupjobs: 9\n");
    pipeline005.migrate(doc);
    expect(doc.getIn(["apply_priority", "berlinstartupjobs"])).toBe(9);
  });
});

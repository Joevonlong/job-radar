// @vitest-environment node
/**
 * sources.yaml 5 -> 6 (the Berlin Design Network discovery block, switched off): placement, values, comments, idempotence.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse, parseDocument } from "yaml";

import { migrateConfigDocument, parseConfigDocument, validateConfigValue } from "@/lib/config";
import { sources006 } from "@/lib/config/migrations/sources/006-berlin-design-network";

import { FIXTURE_DEFAULTS_DIR } from "./helpers";

const SERIALIZE = { lineWidth: 0, flowCollectionPadding: false } as const;

function migrate(text: string): { text: string; steps: number } {
  const doc = parseConfigDocument("channels", text, "test.yaml");
  const result = migrateConfigDocument("channels", doc, "test.yaml");
  return { text: doc.toString(SERIALIZE), steps: result.applied.length };
}

const SMALL_V5 = `config_version: 5
# my channels
sources:
  tavily:
    enabled: true # my search
  brave:
    enabled: false # off for now
  lever:
    enabled: true
`;

describe("sources.yaml 5 -> 6", () => {
  it("brings a v5 file to what the shipped defaults hold, and it validates", () => {
    const doc = parseDocument(fs.readFileSync(path.join(FIXTURE_DEFAULTS_DIR, "sources.yaml"), "utf8"));
    doc.deleteIn(["sources", "berlin_design_network"]);
    doc.set("config_version", 5);
    const { text, steps } = migrate(doc.toString(SERIALIZE));
    expect(steps).toBe(2); // 6 -> 7 (Berlin Startup Jobs) follows
    expect(text).toMatch(/^config_version: 7$/m);
    const shipped = parse(fs.readFileSync(path.join(FIXTURE_DEFAULTS_DIR, "sources.yaml"), "utf8")) as Record<string, unknown>;
    expect(parse(text)).toEqual(shipped);
    expect(validateConfigValue("channels", parse(text), "sources.yaml").sources.berlin_design_network).toMatchObject({
      enabled: false,
      markets: ["DE"],
      monthly_budget_usd: 0,
      base_url: "https://berlin-design-network.org",
      interval_hours: 24,
    });
  });

  it("adds the block after brave with an English comment and keeps every comment of the file", () => {
    const { text } = migrate(SMALL_V5);
    const parsed = parse(text) as { sources: Record<string, Record<string, unknown>> };
    expect(Object.keys(parsed.sources)).toEqual(["tavily", "brave", "berlin_design_network", "lever", "berlinstartupjobs"]);
    expect(parsed.sources.berlin_design_network?.enabled).toBe(false);
    const comment = text.slice(text.indexOf("off for now"), text.indexOf("  berlin_design_network:"));
    expect(comment).toContain("# Berlin Design Network: board discovery only");
    expect(comment).not.toMatch(/[　-鿿]/u);
    for (const kept of ["# my channels", "# my search", "# off for now"]) expect(text).toContain(kept);
    expect(text).toContain("markets: [DE]");
  });

  it("goes after tavily without brave, and last without either", () => {
    const afterTavily = parse(migrate("config_version: 5\nsources:\n  tavily:\n    enabled: true\n  lever:\n    enabled: true\n").text) as { sources: Record<string, unknown> };
    expect(Object.keys(afterTavily.sources)).toEqual(["tavily", "berlin_design_network", "lever", "berlinstartupjobs"]);
    const last = parse(migrate("config_version: 5\nsources:\n  lever:\n    enabled: true\n").text) as { sources: Record<string, unknown> };
    expect(Object.keys(last.sources)).toEqual(["lever", "berlin_design_network", "berlinstartupjobs"]);
  });

  it("is idempotent, leaves an existing block alone, and ignores a file without sources", () => {
    const once = migrate(SMALL_V5).text;
    expect(migrate(once)).toEqual({ text: once, steps: 0 });
    const own = SMALL_V5.replace("  lever:", "  berlin_design_network:\n    enabled: true\n  lever:");
    const doc = parseDocument(own);
    sources006.migrate(doc);
    expect(doc.toString(SERIALIZE)).toBe(parseDocument(own).toString(SERIALIZE));
    const bare = parseDocument("config_version: 5\nlinkedin: {}\n");
    sources006.migrate(bare);
    expect(bare.has("sources")).toBe(false);
  });
});

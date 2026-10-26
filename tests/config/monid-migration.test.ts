// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { migrateConfigDocument, validateConfigValue } from "@/lib/config";
import { sources004 } from "@/lib/config/migrations/sources/004-monid";

import { FIXTURE_DEFAULTS_DIR } from "./helpers";

const OLD_CASCADE = ["linkedin-brightdata", "linkedin-apify", "linkedin-session", "linkedin-guest"];
const NEW_CASCADE = ["linkedin-brightdata", "linkedin-apify", "linkedin-monid", "linkedin-session", "linkedin-guest"];

function legacy() {
  const doc = parseDocument(fs.readFileSync(path.join(FIXTURE_DEFAULTS_DIR, "sources.yaml"), "utf8"));
  doc.set("config_version", 3);
  doc.deleteIn(["linkedin", "monid"]);
  doc.setIn(["linkedin", "cascade"], doc.createNode(OLD_CASCADE));
  return doc;
}

const migrate = (doc: ReturnType<typeof legacy>) => migrateConfigDocument("channels", doc, "sources.yaml");

describe("Monid config migration", () => {
  it("adds the block after Apify, inserts into the old default cascade and stamps version 4", () => {
    const doc = legacy();
    expect(migrate(doc)).toMatchObject({ from: 3, to: 4, applied: [sources004] });
    expect(doc.get("config_version")).toBe(4);
    const config = validateConfigValue("channels", doc.toJS(), "sources.yaml");
    expect(config.linkedin.cascade).toEqual(NEW_CASCADE);
    expect(config.linkedin.monid).toMatchObject({ enabled: true, monthly_budget_usd: 5, max_results: 300,
      provider: "apify", endpoint: "/harvestapi/linkedin-job-search", price_per_1k_usd: 1, flat_fee_usd: 0.001 });
    const keys = Object.keys(config.linkedin);
    expect(keys[keys.indexOf("apify") + 1]).toBe("monid");
    expect(config.paid_total_monthly_budget_usd).toBe(15);
  });

  it.each([0, 2.5, 8])("clamps the new budget to global cap %s, leaves the cap unchanged and validates", (cap) => {
    const doc = legacy();
    doc.set("paid_total_monthly_budget_usd", cap);
    // All pre-existing channels already respect this user's smaller cap.
    for (const key of ["brightdata", "apify", "session", "guest"]) doc.setIn(["linkedin", key, "monthly_budget_usd"], 0);
    const sources = doc.toJS() as { sources: Record<string, unknown> };
    for (const key of Object.keys(sources.sources)) doc.setIn(["sources", key, "monthly_budget_usd"], 0);
    migrate(doc);
    const config = validateConfigValue("channels", doc.toJS(), "sources.yaml");
    expect(config.linkedin.monid.monthly_budget_usd).toBe(Math.min(5, cap));
    expect(config.paid_total_monthly_budget_usd).toBe(cap);
  });

  it.each([
    ["linkedin-apify", "linkedin-brightdata", "linkedin-session", "linkedin-guest"],
    ["linkedin-apify", "linkedin-guest"],
    ["linkedin-apify", "linkedin-monid", "linkedin-guest"],
  ])("keeps a reordered cascade or subset untouched: %j", (...order) => {
    const doc = legacy();
    doc.setIn(["linkedin", "cascade"], doc.createNode(order));
    migrate(doc);
    const config = validateConfigValue("channels", doc.toJS(), "sources.yaml");
    expect(config.linkedin.cascade).toEqual(order);
    expect(config.linkedin.monid.enabled).toBe(false);
    expect(doc.toString()).toContain("Add linkedin-monid to linkedin.cascade and set linkedin.monid.enabled: true");
  });

  it("adds a disabled block when the cascade is missing so it cannot run on its own", () => {
    const doc = legacy();
    doc.deleteIn(["linkedin", "cascade"]);
    migrate(doc);
    expect(doc.hasIn(["linkedin", "cascade"])).toBe(false);
    expect(doc.getIn(["linkedin", "monid", "enabled"])).toBe(false);
    expect(doc.toString()).toContain("Add linkedin-monid to linkedin.cascade and set linkedin.monid.enabled: true");
  });

  it("leaves an existing block and the cascade completely untouched", () => {
    const doc = legacy();
    doc.setIn(["linkedin", "monid"], { enabled: false, custom: "keep" });
    const before = doc.toString();
    sources004.migrate(doc);
    expect(doc.toString()).toBe(before);
  });

  it("runs once: deleting the block or cascade item after migration does not add either back", () => {
    const doc = legacy();
    migrate(doc);
    doc.deleteIn(["linkedin", "monid"]);
    doc.setIn(["linkedin", "cascade"], doc.createNode(OLD_CASCADE));
    const before = doc.toString();
    expect(migrate(doc).applied).toEqual([]);
    expect(doc.toString()).toBe(before);
  });

  it("keeps header, block, cascade and inline comments", () => {
    const doc = parseDocument(`# my sources\nconfig_version: 3 # version note\npaid_total_monthly_budget_usd: 3\nlinkedin:\n  # my cascade\n  cascade:\n    - linkedin-brightdata # free first\n    - linkedin-apify # second\n    - linkedin-session # login\n    - linkedin-guest\n  apify:\n    enabled: false # keep off\n`);
    migrate(doc);
    const text = doc.toString();
    for (const comment of ["# my sources", "# version note", "# my cascade", "# free first", "# second", "# login", "# keep off"]) expect(text).toContain(comment);
    expect(text).toContain("# Monid LinkedIn fallback");
    expect(doc.toJS()).toMatchObject({ linkedin: { cascade: NEW_CASCADE } });
  });

  it("does not construct a missing LinkedIn mapping", () => {
    const doc = parseDocument("config_version: 3\n");
    sources004.migrate(doc);
    expect(doc.has("linkedin")).toBe(false);
  });
});

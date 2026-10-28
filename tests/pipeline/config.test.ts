// @vitest-environment node
import { describe, expect, it } from "vitest";

import { CHANNEL_FAMILIES } from "@/lib/channels/types";
import { configRegistry } from "@/lib/config";
import { WATCH_RECHECK_DEFAULTS } from "@/lib/config/schemas/pipeline";

import { shippedYaml } from "../config/helpers";
import { fixturePack, shippedPipeline } from "./helpers";

/** A `language.requirement` block (it replaces the pack's German rules), valid: the DE pack's. */
const requirement = (): Json => structuredClone(fixturePack("de").language.requirement) as unknown as Json;

type Json = Record<string, unknown>;
const fixture = (): Json => structuredClone(shippedYaml("pipeline.yaml"));
const issues = (input: unknown): string[] => {
  const result = configRegistry.pipeline.schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => (i.code === "unrecognized_keys" ? [...i.path, ...i.keys].join(".") : i.path.join(".")));
};
const at = (obj: unknown, ...keys: string[]): Json => keys.reduce<unknown>((cur, k) => (cur as Json)[k], obj) as Json;

describe("pipeline.yaml", () => {
  it("lifecycle.watch_recheck takes its own values and rejects unknown keys and bad numbers", () => {
    const own = fixture();
    at(own, "lifecycle").watch_recheck = { interval_hours: 24, max_per_cycle: 3, per_host_min_interval_ms: 500, timeout_ms: 2000, max_body_bytes: 4096, user_agent: "Test/1" };
    expect(issues(own)).toEqual([]);
    const bad = fixture();
    at(bad, "lifecycle").watch_recheck = { ...WATCH_RECHECK_DEFAULTS, interval_hours: 0, extra: 1 };
    expect(issues(bad)).toEqual(expect.arrayContaining(["lifecycle.watch_recheck.interval_hours", "lifecycle.watch_recheck.extra"]));
  });

  it("ships the documented defaults", () => {
    const config = shippedPipeline();
    expect(config.dedupe.simhash_max_distance).toBe(3);
    // Missing watched-recheck and unseen-link-check keys get the schema's defaults.
    expect(config.lifecycle).toEqual({ dormant_after_days: 30, possibly_closed_after_days: 7, unseen_link_check_after_days: 14, unseen_link_check_interval_days: 7, max_link_checks_per_cycle: 20, link_check_timeout_ms: 10000, watch_recheck: WATCH_RECHECK_DEFAULTS });
    expect(config.apply_priority.ats).toBe(1);
    expect(config.apply_priority.linkedin).toBe(2);
    expect(config.apply_priority.stepstone).toBe(3);
    expect(config.apply_priority.xing).toBe(3);
    expect(config.apply_priority.indeed).toBe(3);
    expect(config.apply_priority.arbeitsagentur).toBe(4);
    expect(config.salary.periods_per_year).toEqual({ year: 1, month: 12, week: 52, day: 260, hour: 2080 });
  });

  it("has a priority for every channel family", () => {
    expect(Object.keys(shippedPipeline().apply_priority).sort()).toEqual([...CHANNEL_FAMILIES].sort());
    const missing = fixture();
    delete at(missing, "apply_priority").ats;
    expect(issues(missing)).toContain("apply_priority.ats");
  });

  it("rejects bad regular expressions with their path", () => {
    const bad = fixture();
    (at(bad, "contract").student as string[]).push("(unclosed");
    at(bad, "language").requirement = { ...requirement(), optional_patterns: ["["] };
    (bad.skills as Json[]).push({ name: "X", pattern: "*" });
    expect(issues(bad)).toEqual(expect.arrayContaining([`contract.student.${(at(bad, "contract").student as string[]).length - 1}`, "skills.17.pattern"]));
    expect(issues(bad).some((p) => p.startsWith("language.requirement.optional_patterns."))).toBe(true);
  });

  it("rejects out-of-range values", () => {
    const bad = fixture();
    at(bad, "dedupe").simhash_max_distance = 65;
    at(bad, "lifecycle").possibly_closed_after_days = 0;
    at(bad, "salary").plausible_annual = { min: 5, max: 5 };
    at(bad, "salary").fx_rates = { usd: 0.9 };
    at(bad, "language").requirement = { ...requirement(), level_rules: [{ pattern: "x", level: "D1" }] };
    expect(issues(bad)).toEqual(
      expect.arrayContaining(["dedupe.simhash_max_distance", "lifecycle.possibly_closed_after_days", "salary.plausible_annual", "language.requirement.level_rules.0.level"]),
    );
    expect(issues(bad).some((p) => p.startsWith("salary.fx_rates"))).toBe(true);
  });

  it("rejects an unknown key in a nested block (typo guard)", () => {
    const bad = fixture();
    at(bad, "dedupe").simhash_distance = 3;
    expect(issues(bad)).toContain("dedupe.simhash_distance");
  });

  it("ships the extraction rules (work mode, German, agency, description clean-up)", () => {
    const config = shippedPipeline();
    for (const mode of ["remote", "hybrid", "onsite"] as const) {
      expect(config.workplace.head[mode].length).toBeGreaterThan(0);
      expect(config.workplace.text[mode].length).toBeGreaterThan(0);
    }
    expect(config.language.requirement?.optional_max_distance).toBeGreaterThan(0);
    expect(config.company.agency_names).toEqual(expect.arrayContaining(["Jack & Jill", "Acceler8 Talent", "Findr", "AI Futures"]));
    expect(config.description.restore.section_headings.length).toBeGreaterThan(10);
  });

  it("rejects bad regular expressions in the new lists and a missing block", () => {
    const bad = fixture();
    (at(bad, "workplace", "text").hybrid as string[]).push("(unclosed");
    (at(bad, "agency").exclude_context_patterns as string[]).push("[");
    (at(bad, "description").trailing_ui_patterns as string[]).push("*");
    at(bad, "language").requirement = { ...requirement(), preferred_section_patterns: ["("] };
    expect(issues(bad)).toEqual(
      expect.arrayContaining([
        `workplace.text.hybrid.${(at(bad, "workplace", "text").hybrid as string[]).length - 1}`,
        `agency.exclude_context_patterns.${(at(bad, "agency").exclude_context_patterns as string[]).length - 1}`,
        `description.trailing_ui_patterns.${(at(bad, "description").trailing_ui_patterns as string[]).length - 1}`,
        "language.requirement.preferred_section_patterns.0",
      ]),
    );
    const missing = fixture();
    delete missing.workplace;
    expect(issues(missing)).toContain("workplace");
  });
});

import fs from "node:fs";
import path from "node:path";

import { parse } from "yaml";

import { FIXTURE_DEFAULTS_DIR } from "../config/helpers";
import { configRegistry, type MeConfig, type PreferencesConfig, type TrapsConfig } from "@/lib/config";

export const TRAP_FIXTURES = path.resolve(import.meta.dirname, "../fixtures/traps");

export function trapFixture(name: string): string {
  return fs.readFileSync(path.join(TRAP_FIXTURES, name), "utf8");
}

/**
 * The trap settings every test builds on: the shipped traps.yaml patterns (the rules under test) with the switches and thresholds
 * pinned here, so a change of a threshold in the repository's file never changes a test.
 */
export function trapSettings(edit: (raw: Record<string, unknown>) => void = () => {}): TrapsConfig {
  const raw = parse(fs.readFileSync(path.join(FIXTURE_DEFAULTS_DIR, "traps.yaml"), "utf8")) as Record<string, unknown>;
  raw.enabled = true;
  raw.scan = { per_cycle_limit: 200, min_hidden_chars: 8, quote_max_chars: 400, max_findings_per_job: 20, backlog_warn: 500, recent_days: 7 };
  raw.hidden = {
    ...(raw.hidden as Record<string, unknown>),
    methods: Object.fromEntries(Object.keys((raw.hidden as { methods: Record<string, boolean> }).methods).map((m) => [m, true])),
    color: { min_contrast: 1.5, assumed_background: ["#ffffff"] },
    opacity_max: 0.1,
    font_size_max_px: 1,
    offscreen_min_px: 500,
    size_max_px: 1,
    classes: ["sr-only", "visually-hidden", "hidden", "d-none"],
  };
  raw.invisible_unicode = { tag_chars: true, zero_width: true, zero_width_min_run: 2, bidi_controls: true };
  raw.instruction_languages = ["en", "de", "zh"];
  raw.ai_check = { ...(raw.ai_check as Record<string, unknown>), mode: "flagged", per_cycle_limit: 10, jd_max_chars: 12000 };
  raw.ai_input = { hidden_marker: "[hidden text removed by Job Radar]", instruction_marker: "[instruction to AI removed by Job Radar]" };
  edit(raw);
  return configRegistry.traps.schema.parse(raw);
}

/** A fixed profile (not the repository's example files). */
export function fixedMe(): MeConfig {
  return configRegistry.me.schema.parse({
    languages: [{ en: "C1" }, { de: "B1" }, { es: "native" }],
    skills: [{ name: "Python", years: 6 }, { name: "RAG", years: null }],
    years_experience: 8,
    city: "Berlin",
    needs_visa_sponsorship: false,
    summary: "Applied ML engineer who ships LLM products.",
  });
}

export function fixedPreferences(): PreferencesConfig {
  return configRegistry.preferences.schema.parse({
    market: { pack: "de" },
    target_titles: ["AI Engineer", "Forward Deployed Engineer"],
    locations: ["Berlin", "München"],
    workplace: ["onsite", "hybrid", "remote"],
    remote_scope: "home_country",
    seniority: "all",
    salary_floor_year: 70000,
    contracts: { allow: ["permanent", "fixed_term", "freelance"], exclude: ["temp_agency"] },
    exclude_student_roles: true,
    exclude_companies: [],
    exclude_keywords: [],
  });
}

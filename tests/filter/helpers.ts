import { configRegistry, type PipelineConfig, type PreferencesConfig } from "@/lib/config";
import type { JobLocation, JobSalary } from "@/lib/domain/types";
import { compileFilter, type CompiledFilter, type FilterJob } from "@/lib/filter";

import { shippedYaml } from "../config/helpers";
import { shippedPipeline } from "../pipeline/helpers";
import { asSalary } from "../helpers/salary";

/** The shipped preferences template, validated, with a deep edit applied. */
export function prefs(edit: (raw: Record<string, unknown>) => void = () => {}): PreferencesConfig {
  const raw = structuredClone(shippedYaml("profile.example/preferences.yaml"));
  edit(raw);
  return configRegistry.preferences.schema.parse(raw);
}

export function filterWith(preferences: PreferencesConfig = prefs(), pipeline: PipelineConfig = shippedPipeline()): CompiledFilter {
  return compileFilter(preferences, pipeline);
}

export const loc = (label: string, city: string | null = null, countryCode: string | null = null): JobLocation => ({ label, city, countryCode, isPrimary: false });

export function salary(eurMin: number | null, eurMax: number | null, over: Partial<JobSalary> = {}): JobSalary {
  return asSalary({
    raw: "x",
    currency: "EUR",
    period: "year",
    min: eurMin,
    max: eurMax,
    perYear: { min: eurMin, max: eurMax },
    eurPerYear: { min: eurMin, max: eurMax },
    periodAssumed: false,
    origin: "channel",
    qualityStatus: "valid",
    reasonCodes: [],
    ...over,
  });
}

/** A job that passes every rule of the shipped preferences, with overrides. */
export function job(over: Partial<FilterJob> = {}): FilterJob {
  return {
    title: "Applied AI Engineer",
    description: "Build LLM features for our platform.",
    companyName: "Northwind Labs GmbH",
    companyAliases: [],
    companyBlacklisted: false,
    locations: [loc("Berlin", "Berlin", "DE")],
    workplace: "hybrid",
    seniority: "senior",
    contract: "permanent",
    salary: null,
    germanLevel: "unknown",
    ...over,
  };
}

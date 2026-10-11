import type { SuggestOutput } from "@/lib/ai/prompts/suggest";
import { configRegistry, type SuggestConfig } from "@/lib/config";
import type { SuggestionSourceJob } from "@/lib/db/repos/interest-suggestions";
import { resolveCompanyName } from "@/lib/pipeline/company";
import type { ValidationContext } from "@/lib/interests/suggest-validate";

import { shippedYaml } from "../config/helpers";
import { examplePreferences } from "../scoring/helpers";
import { shippedInterests, shippedPipeline } from "../signals/helpers";

export function shippedSuggest(edit: (raw: Record<string, unknown>) => void = () => {}): SuggestConfig {
  const raw = structuredClone(shippedYaml("schedule.yaml"));
  edit(raw.suggest as Record<string, unknown>);
  return configRegistry.schedule.schema.parse(raw).suggest;
}

export const normalizeCompany = (name: string): string => resolveCompanyName(name, shippedPipeline()).nameNorm;

let nextId = 1;

/** A job the user acted on. Descriptions are plain English sentences so quotes are easy to write. */
export function sourceJob(overrides: Partial<SuggestionSourceJob> = {}): SuggestionSourceJob {
  const jobId = overrides.jobId ?? nextId++;
  return {
    jobId,
    title: `Applied AI Engineer ${jobId}`,
    companyName: `Company ${jobId} GmbH`,
    companyNorm: `company-${jobId}`,
    locationsJson: [{ label: "Berlin, Germany", city: "Berlin", countryCode: "DE", isPrimary: true }],
    workplace: "hybrid",
    seniority: "mid",
    skills: [],
    description: `We build LLM products. We offer virtual shares and a JobRad lease. Job ${jobId}.`,
    applicationStatus: "interested",
    statusChangedAt: new Date("2026-10-01T10:00:00Z"),
    ...overrides,
  };
}

export const emptyOutput = (): SuggestOutput => ({ signal_words: [], companies: [], filters: [] });

export function context(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    positive: [],
    ignored: [],
    interests: shippedInterests(),
    preferences: examplePreferences(),
    config: shippedSuggest(),
    normalizeCompany,
    ...overrides,
  };
}

export const reasons = { reason_zh: "理由", reason_en: "reason", confidence: 0.8 };

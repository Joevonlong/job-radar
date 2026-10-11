import {
  CONTRACTS,
  GERMAN_LEVELS,
  JOB_LANGUAGES,
  jobLocationSchema,
  jobSalarySchema,
  type Contract,
  type GermanLevel,
  type JobLanguage,
  type JobLocation,
  type JobSalary,
} from "@/lib/domain/types";

/** The text columns `contract` / `german_level_required` / `language` hold the pipeline vocabulary; anything else reads as `unknown` (C3). */
export function asContract(value: string): Contract {
  return CONTRACTS.find((c) => c === value) ?? "unknown";
}
export function asGermanLevel(value: string): GermanLevel {
  return GERMAN_LEVELS.find((l) => l === value) ?? "unknown";
}
export function asJobLanguage(value: string): JobLanguage {
  return JOB_LANGUAGES.find((l) => l === value) ?? "unknown";
}

/** `jobs.locations_json` → locations, primary first. Entries that do not match the stored shape are dropped, never invented. */
export function parseLocations(value: unknown): JobLocation[] {
  if (!Array.isArray(value)) return [];
  const out: JobLocation[] = [];
  for (const item of value) {
    const parsed = jobLocationSchema.safeParse(item);
    if (parsed.success && parsed.data.label.trim() !== "") out.push(parsed.data);
  }
  return out.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
}

/**
 * `jobs.salary_json` → salary, or null when it is absent (the posting states none, C3) or does not
 * match the stored shape (callers still know a salary exists from `salary_json` being set).
 */
export function parseSalary(value: unknown): JobSalary | null {
  if (value === null || value === undefined) return null;
  const parsed = jobSalarySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

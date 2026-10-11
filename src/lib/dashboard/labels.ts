import { CONTRACTS, type Contract } from "@/lib/domain/types";

/**
 * Values that have a translated label in `dashboard.source.*`. Data can carry values outside the
 * list (a new channel family): callers show those verbatim instead of failing.
 */
export const KNOWN_FAMILIES = ["ats", "linkedin", "stepstone", "xing", "indeed", "arbeitsagentur", "arbeitnow", "google", "email", "manual"] as const;
export type KnownFamily = (typeof KNOWN_FAMILIES)[number];

export function knownFamily(value: string): KnownFamily | null {
  return KNOWN_FAMILIES.find((f) => f === value) ?? null;
}

/** Contract values come from the pipeline (`CONTRACTS`); `dashboard.contract.*` has a label for each. */
export function knownContract(value: string): Contract | null {
  return CONTRACTS.find((c) => c === value) ?? null;
}

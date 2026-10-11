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

/** The display names of the company ATS channels (brand names: the same in every language); other channels show their family's label. */
const ATS_NAMES: Readonly<Record<string, string>> = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", personio: "Personio", smartrecruiters: "SmartRecruiters" };

/** A channel as the pages name it: the ATS brand, else the family's translated label (`familyLabel`), else the channel id. */
export function channelDisplayName(channelId: string, family: string | null, familyLabel: (family: KnownFamily) => string): string {
  const ats = ATS_NAMES[channelId];
  if (ats !== undefined) return ats;
  const known = family === null ? null : knownFamily(family);
  return known ? familyLabel(known) : channelId;
}

/** Contract values come from the pipeline (`CONTRACTS`); `dashboard.contract.*` has a label for each. */
export function knownContract(value: string): Contract | null {
  return CONTRACTS.find((c) => c === value) ?? null;
}

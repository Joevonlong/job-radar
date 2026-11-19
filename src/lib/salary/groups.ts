import { ANY, normCity } from "./benchmark";

export const GROUP_LEVELS = ["city", "country", "family_country", "family"] as const;
export type GroupLevel = (typeof GROUP_LEVELS)[number];

/** Candidate groups in fallback order. A changed or deleted group can affect any of its candidates. */
export function salaryGroupCandidates(job: { seniority: string; city: string | null; country: string | null }) {
  const seniority = job.seniority.toLowerCase();
  const known = seniority !== "unknown" && seniority !== "";
  const country = job.country?.toUpperCase() ?? null;
  return [
    ...(known && job.city ? [{ level: "city", seniority, geoLevel: "city", geoKey: normCity(job.city) }] as const : []),
    ...(known && country !== null ? [{ level: "country", seniority, geoLevel: "country", geoKey: country }] as const : []),
    ...(country !== null ? [{ level: "family_country", seniority: ANY, geoLevel: "country", geoKey: country }] as const : []),
    { level: "family", seniority: ANY, geoLevel: "all", geoKey: ANY } as const,
  ];
}

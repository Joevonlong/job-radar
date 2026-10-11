import { z } from "zod";

import type { PipelineConfig } from "@/lib/config";
import type { Executor } from "@/lib/db/executor";
import { findJobByFamilyExternalId, getJob, listJobsByCompanyTitle, listJobsOfOtherCompaniesByTitle, listJobsWithSimhash, type Job } from "@/lib/db/repos/jobs";
import { jobLocationSchema, type JobLocation } from "@/lib/domain/types";

import { resolveCompanyName } from "./company";
import { cityKeys } from "./geography";
import type { NormalizedJob } from "./normalize";
import { hammingDistance } from "./simhash";

export type MatchKind = "same_source" | "exact_key" | "simhash";

export interface JobMatch {
  job: Job;
  kind: MatchKind;
}

const locationsSchema = z.array(jobLocationSchema);

/** The locations stored on a job (`locations_json`), validated (C6); unreadable JSON counts as none. */
export function storedLocations(job: Pick<Job, "locationsJson">): JobLocation[] {
  const parsed = locationsSchema.safeParse(job.locationsJson);
  return parsed.success ? parsed.data : [];
}

/**
 * Same city for the exact key: the two location lists share a city, or neither names any city
 * (e.g. both remote). One side with a city and the other without is not the same key (the
 * SimHash pass can still merge them).
 */
export function sameCity(a: ReadonlyArray<Pick<JobLocation, "city">>, b: ReadonlyArray<Pick<JobLocation, "city">>): boolean {
  const left = cityKeys(a);
  const right = cityKeys(b);
  if (left.size === 0 && right.size === 0) return true;
  for (const key of left) if (right.has(key)) return true;
  return false;
}

/**
 * Whether two company keys (`normalizeCompanyKey`) name the same employer under different spellings:
 * equal, one a word-prefix of the other ("siv" / "siv-ag-service-fur-informationsverarbeitung"), or the
 * same first word ("allianz-in-deutschland" / "allianz-kunde-und-markt"). Only a candidate filter: the
 * caller also needs the same title and a near-identical description.
 */
export function relatedCompanyKeys(a: string, b: string): boolean {
  if (a === "" || b === "") return false;
  if (a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`)) return true;
  return a.split("-")[0] === b.split("-")[0];
}

export interface MatchInput {
  normalized: NormalizedJob;
  companyId: number;
  /** The posting's company name, as the channel wrote it. */
  companyName: string;
  channelFamily: string;
  externalId: string;
  rawPostingId: number;
}

/**
 * The existing job a new posting belongs to, if any, trying in order:
 * 1. same source: a posting with the same external id from the same channel family;
 * 2. exact key: same company, same normalized title, same city;
 * 3. SimHash: same company and description SimHash within `dedupe.simhash_max_distance` bits.
 * 4. related company: another company whose name is a variant of this one's (see `relatedCompanyKeys`), same
 *    normalized title and a SimHash within `dedupe.cross_company_simhash_max_distance` (counted as `simhash`).
 * The oldest candidate wins, so repeated runs merge into the same job.
 */
export async function findMatchingJob(db: Executor, input: MatchInput, config: PipelineConfig): Promise<JobMatch | null> {
  const sameSource = await findJobByFamilyExternalId(db, {
    family: input.channelFamily,
    externalId: input.externalId,
    excludeRawPostingId: input.rawPostingId,
  });
  if (sameSource) return { job: sameSource, kind: "same_source" };

  const candidates = await listJobsByCompanyTitle(db, input.companyId, input.normalized.titleNorm);
  const exact = candidates.find((job) => sameCity(storedLocations(job), input.normalized.locations));
  if (exact) return { job: exact, kind: "exact_key" };

  const hash = input.normalized.simhash;
  if (hash !== null) {
    for (const candidate of await listJobsWithSimhash(db, input.companyId)) {
      if (candidate.simhash === null) continue;
      if (hammingDistance(hash, candidate.simhash) <= config.dedupe.simhash_max_distance) {
        const job = await getJob(db, candidate.id);
        if (job) return { job, kind: "simhash" };
      }
    }
  }
  if (hash !== null) {
    const companyKey = resolveCompanyName(input.companyName, config).nameNorm;
    for (const candidate of await listJobsOfOtherCompaniesByTitle(db, input.companyId, input.normalized.titleNorm)) {
      if (candidate.simhash === null || !relatedCompanyKeys(companyKey, candidate.companyNameNorm)) continue;
      if (hammingDistance(hash, candidate.simhash) <= config.dedupe.cross_company_simhash_max_distance) {
        const job = await getJob(db, candidate.id);
        if (job) return { job, kind: "simhash" };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- merge

export interface JobFields {
  title: string;
  titleNorm: string;
  locationsJson: JobLocation[];
  workplace: Job["workplace"];
  seniority: string;
  contract: string;
  salaryJson: unknown;
  description: string | null;
  language: string;
  germanLevelRequired: string;
  postedAt: Date | null;
  simhash: string | null;
  isAgency: boolean;
  skills: string[];
}

/** The job fields a normalized posting would create. */
export function fieldsOf(n: NormalizedJob): JobFields {
  return {
    title: n.title,
    titleNorm: n.titleNorm,
    locationsJson: n.locations,
    workplace: n.workplace,
    seniority: n.seniority,
    contract: n.contract,
    salaryJson: n.salary,
    description: n.description === "" ? null : n.description,
    language: n.language,
    germanLevelRequired: n.germanLevelRequired,
    postedAt: n.postedAt,
    simhash: n.simhash,
    isAgency: n.isAgency,
    skills: n.skills,
  };
}

export function fieldsOfJob(job: Job): JobFields {
  return {
    title: job.title,
    titleNorm: job.titleNorm,
    locationsJson: storedLocations(job),
    workplace: job.workplace,
    seniority: job.seniority,
    contract: job.contract,
    salaryJson: job.salaryJson,
    description: job.description,
    language: job.language,
    germanLevelRequired: job.germanLevelRequired,
    postedAt: job.postedAt,
    simhash: job.simhash,
    isAgency: job.isAgency,
    skills: job.skills,
  };
}

/** 0 = no salary, 1 = salary needing review, 2 = valid salary. */
export function salaryRank(salary: unknown): number {
  if (salary === null || typeof salary !== "object") return 0;
  return (salary as { qualityStatus?: unknown }).qualityStatus === "valid" ? 2 : 1;
}

function unionLocations(first: readonly JobLocation[], second: readonly JobLocation[]): JobLocation[] {
  const seen = new Set<string>();
  const merged: JobLocation[] = [];
  for (const location of [...first, ...second]) {
    const key = `${location.countryCode ?? "xx"}:${(location.city ?? location.label).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...location, isPrimary: false });
  }
  if (merged[0]) merged[0] = { ...merged[0], isPrimary: true };
  return merged;
}

/**
 * Fold a new source's fields into the job it matched. When the new source has the best (or equal)
 * apply-link priority it wins every field it states; otherwise it only fills what the job does not
 * know yet. A known value is never replaced by `unknown` (C3). Locations, skills and the agency
 * flag accumulate; the earliest posting date is kept.
 */
export function mergeJobFields(existing: JobFields, incoming: JobFields, incomingWins: boolean): JobFields {
  const pick = <T>(current: T, next: T, isUnknown: (value: T) => boolean): T => {
    if (isUnknown(next)) return current;
    if (isUnknown(current)) return next;
    return incomingWins ? next : current;
  };
  const unknownText = (v: string): boolean => v === "unknown";

  const description =
    incoming.description === null ? existing.description : incomingWins || existing.description === null ? incoming.description : existing.description;
  const germanFrom = description === null || incoming.description === existing.description ? null : description === incoming.description ? incoming : description === existing.description ? existing : null;
  const incomingRank = salaryRank(incoming.salaryJson);
  const existingRank = salaryRank(existing.salaryJson);
  const takeIncomingSalary = incomingRank > existingRank || (incomingWins && incomingRank === existingRank && incomingRank > 0);
  const posted = [existing.postedAt, incoming.postedAt].filter((d): d is Date => d !== null);

  return {
    title: incomingWins ? incoming.title : existing.title,
    titleNorm: incomingWins ? incoming.titleNorm : existing.titleNorm,
    locationsJson: incomingWins ? unionLocations(incoming.locationsJson, existing.locationsJson) : unionLocations(existing.locationsJson, incoming.locationsJson),
    workplace: pick(existing.workplace, incoming.workplace, (v) => v === "unknown"),
    seniority: pick(existing.seniority, incoming.seniority, unknownText),
    contract: pick(existing.contract, incoming.contract, unknownText),
    salaryJson: takeIncomingSalary ? incoming.salaryJson : existing.salaryJson,
    description,
    language: pick(existing.language, incoming.language, unknownText),
    // the German level is read from the description, so it follows the description that is kept: a sibling posting
    // (the DACH variant of a Nordics role) must not hand its "German C1" to a description that never mentions German
    germanLevelRequired: germanFrom ? germanFrom.germanLevelRequired : pick(existing.germanLevelRequired, incoming.germanLevelRequired, unknownText),
    postedAt: posted.length === 0 ? null : new Date(Math.min(...posted.map((d) => d.getTime()))),
    simhash: description === existing.description ? existing.simhash : incoming.simhash,
    isAgency: existing.isAgency || incoming.isAgency,
    skills: [...new Set([...existing.skills, ...incoming.skills])],
  };
}

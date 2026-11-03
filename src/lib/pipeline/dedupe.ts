import { z } from "zod";

import type { PipelineConfig } from "@/lib/config";
import type { Executor } from "@/lib/db/executor";
import { findJobByFamilyExternalId, getJob, listJobsByCompanyTitle, listJobsOfOtherCompaniesByTitle, listJobsWithSimhash, type Job, type SimhashCandidateRow } from "@/lib/db/repos/jobs";
import { jobLocationSchema, type JobLocation } from "@/lib/domain/types";

import { resolveCompanyName } from "./company";
import { cityKeys } from "./geography";
import type { NormalizedJob } from "./normalize";
import { hammingDistance } from "./simhash";
import { compileTitleGuard, selectSimhashCandidate, type SimhashCandidate, type TitleRelation } from "./title-guard";

export type MatchKind = "same_source" | "exact_key" | "simhash";

/** The pass that matched; the related-company pass still counts as `simhash` in `MatchKind`. */
export type MatchRule = "same_source" | "exact_key" | "simhash" | "related_company";

/** Why a posting joined a job. `title` is set by the two SimHash passes while the title guard is on. */
export interface MatchDetail {
  rule: MatchRule;
  title: TitleRelation | null;
  distance: number | null;
  limit: number | null;
  comparedTitle: string | null;
}

export interface JobMatch {
  job: Job;
  kind: MatchKind;
  detail: MatchDetail;
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

/** Same company with a SimHash (the SimHash pass). `locations` went through `storedLocations`. */
export interface MatchCandidate extends SimhashCandidate {
  locations: JobLocation[];
}

/** Other company, same title key (the related-company pass). */
export interface RelatedCandidate extends MatchCandidate {
  companyNameNorm: string;
}

/**
 * What the passes read, one call per pass that is reached: a pass that matches leaves the later ones unread. Every list is
 * in id order. The database shell and the offline replay each provide these.
 */
export interface MatchLoaders {
  sameSource(): Promise<{ id: number } | null>;
  byCompanyTitle(): Promise<Array<{ id: number; locations: JobLocation[] }>>;
  sameCompanyWithHash(): Promise<MatchCandidate[]>;
  relatedCompanyByTitle(): Promise<RelatedCandidate[]>;
}

export interface MatchDecision {
  jobId: number;
  rule: MatchRule;
  detail: MatchDetail;
}

export interface DecideResult {
  decision: MatchDecision | null;
  /** No pass matched, and the SimHash pass held back a candidate of another title the old rule would have merged. */
  blockedByTitle: boolean;
}

const plainDecision = (jobId: number, rule: MatchRule): DecideResult => ({ decision: { jobId, rule, detail: { rule, title: null, distance: null, limit: null, comparedTitle: null } }, blockedByTitle: false });

/**
 * The job a new posting belongs to, if any, trying in order:
 * 1. same source: a posting with the same external id from the same channel family;
 * 2. exact key: same company, same normalized title, same city (never for an empty title key);
 * 3. SimHash: same company, description SimHash within the limit of the two titles' relation (see `selectSimhashCandidate`);
 * 4. related company: another company whose name is a variant of this one's (see `relatedCompanyKeys`), same normalized title
 *    and a SimHash within `dedupe.cross_company_simhash_max_distance`.
 * Ids in `exclude` count as absent in every pass. Passes 1, 2 and 4 take the oldest candidate, so repeated runs merge into the
 * same job. Reads no database itself: production and the offline replay share it.
 */
export async function decideMatch(input: MatchInput, loaders: MatchLoaders, config: PipelineConfig, exclude: ReadonlySet<number>): Promise<DecideResult> {
  const present = <T extends { id: number }>(rows: readonly T[]): T[] => rows.filter((row) => !exclude.has(row.id));
  const { normalized } = input;

  const sameSource = await loaders.sameSource();
  if (sameSource && !exclude.has(sameSource.id)) return plainDecision(sameSource.id, "same_source");

  // a title without letters or digits keys as "": that says nothing about which job it is, so only the other passes can match it
  if (normalized.titleNorm !== "") {
    const exact = present(await loaders.byCompanyTitle()).find((job) => sameCity(job.locations, normalized.locations));
    if (exact) return plainDecision(exact.id, "exact_key");
  }

  const hash = normalized.simhash;
  if (hash === null) return { decision: null, blockedByTitle: false };

  const guard = config.dedupe.title_guard;
  const compiled = compileTitleGuard(guard, config.market);
  const incoming = { title: normalized.title, titleNorm: normalized.titleNorm, locations: normalized.locations, simhash: hash };
  const { selected, blocked } = selectSimhashCandidate(incoming, present(await loaders.sameCompanyWithHash()), config.dedupe, compiled);
  if (selected) {
    const detail: MatchDetail = { rule: "simhash", title: selected.relation, distance: selected.distance, limit: selected.limit, comparedTitle: selected.candidate.title };
    return { decision: { jobId: selected.candidate.id, rule: "simhash", detail }, blockedByTitle: false };
  }

  if (normalized.titleNorm !== "") {
    const companyKey = resolveCompanyName(input.companyName, config).nameNorm;
    const limit = config.dedupe.cross_company_simhash_max_distance;
    for (const candidate of present(await loaders.relatedCompanyByTitle())) {
      if (candidate.simhash === null || !relatedCompanyKeys(companyKey, candidate.companyNameNorm)) continue;
      const distance = hammingDistance(hash, candidate.simhash);
      if (distance > limit) continue;
      const detail: MatchDetail = { rule: "related_company", title: guard.enabled ? "same" : null, distance, limit, comparedTitle: candidate.title };
      return { decision: { jobId: candidate.id, rule: "related_company", detail }, blockedByTitle: false };
    }
  }
  return { decision: null, blockedByTitle: blocked };
}

/** Run a loader at most once. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let result: Promise<T> | null = null;
  return () => (result ??= load());
}

const candidateOf = (row: SimhashCandidateRow): MatchCandidate => ({ id: row.id, simhash: row.simhash, title: row.title, titleNorm: row.titleNorm, locations: storedLocations(row) });

export interface FindMatchResult {
  match: JobMatch | null;
  blockedByTitle: boolean;
}

/**
 * `decideMatch` on the database. A job that is gone by the time it is fetched counts as absent: the decision is made again
 * without it, so the next eligible candidate gets its turn.
 */
export async function findMatchingJob(db: Executor, input: MatchInput, config: PipelineConfig): Promise<FindMatchResult> {
  const fetched = new Map<number, Job>();
  const remember = (job: Job): Job => {
    fetched.set(job.id, job);
    return job;
  };
  const loaders: MatchLoaders = {
    sameSource: once(async () => {
      const job = await findJobByFamilyExternalId(db, { family: input.channelFamily, externalId: input.externalId, excludeRawPostingId: input.rawPostingId });
      return job && { id: remember(job).id };
    }),
    byCompanyTitle: once(async () => (await listJobsByCompanyTitle(db, input.companyId, input.normalized.titleNorm)).map((job) => ({ id: remember(job).id, locations: storedLocations(job) }))),
    sameCompanyWithHash: once(async () => (await listJobsWithSimhash(db, input.companyId)).map(candidateOf)),
    relatedCompanyByTitle: once(async () => (await listJobsOfOtherCompaniesByTitle(db, input.companyId, input.normalized.titleNorm)).map((row) => ({ ...candidateOf(row), companyNameNorm: row.companyNameNorm }))),
  };
  const exclude = new Set<number>();
  for (;;) {
    const { decision, blockedByTitle } = await decideMatch(input, loaders, config, exclude);
    if (!decision) return { match: null, blockedByTitle };
    const job = fetched.get(decision.jobId) ?? (await getJob(db, decision.jobId));
    if (job) return { match: { job, kind: decision.rule === "related_company" ? "simhash" : decision.rule, detail: decision.detail }, blockedByTitle: false };
    exclude.add(decision.jobId);
  }
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

export function fieldsOfJob(job: Pick<Job, keyof JobFields>): JobFields {
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

export function unionLocations(first: readonly JobLocation[], second: readonly JobLocation[]): JobLocation[] {
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

/** A new source wins a job's fields when no other source has a better apply-link priority. */
export function sourceWins(priority: number, otherBest: number | null): boolean {
  return otherBest === null || priority <= otherBest;
}

/** The job's fields after a posting joined it; a winning source also brings its company. */
export function applyMerge(job: JobFields, incoming: JobFields, wins: boolean, incomingCompanyId: number): JobFields & { companyId?: number } {
  const merged = mergeJobFields(job, incoming, wins);
  return wins ? { ...merged, companyId: incomingCompanyId } : merged;
}

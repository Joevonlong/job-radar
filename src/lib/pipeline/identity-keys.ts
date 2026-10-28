import type { ChannelLogger } from "@/lib/channels/types";
import type { PipelineConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { addCompanyAlias, foldCompanyInto, insertCompanyIfAbsent, listCompanyKeys, setCompanyNameNorm } from "@/lib/db/repos/companies";
import { listJobsWithRawPostings, unlinkJobSources } from "@/lib/db/repos/job-sources";
import { jobIdsWithUserState, listJobTitleKeys, setJobTitleNorms, updateJob } from "@/lib/db/repos/jobs";
import { requeueRawPostingsById, type RawPosting } from "@/lib/db/repos/raw-postings";
import { getRuntimeState, setRuntimeState } from "@/lib/db/repos/runtime-state";
import { rekeySalaryLookupTitles } from "@/lib/db/repos/salary-lookups";
import type { JobLocation } from "@/lib/domain/types";

import { normalizeCompanyKey, resolveCompanyName } from "./company";
import { unionLocations } from "./dedupe";
import { slugify } from "./geography";
import { normalizeTitle } from "./normalize";

/**
 * Version of the stored identity keys (`companies.name_norm`, `jobs.title_norm`; city slugs are worked out when matching).
 * Version 2 keeps the letters, marks and digits of every script; version 1 kept only `a-z` / `0-9`, so a name or title in another script keyed as "" (or as its Latin part
 * only) and different employers or roles shared one key.
 */
export const IDENTITY_KEYS_VERSION = 2;

/** Key of the state row that remembers which key version the stored keys were recomputed with. */
export const IDENTITY_KEYS_STATE_KEY = "pipeline:identity_keys_version";

// ---------------------------------------------------------------- version 1 (frozen)

const LEGACY_GENDER_MARKER = /[([]?\s*\b(?:[mwfdxi*]\s*[/|\\]\s*[mwfdxi*](?:\s*[/|\\]\s*[mwfdxi*])?|all\s+genders?|gn)\b\s*[)\]]?/giu;

/** `normalizeCompanyKey` of key version 1, frozen: tells which stored company keys version 2 changes. */
export function legacyCompanyKey(name: string, legalSuffixes: readonly string[]): string {
  const suffixes = new Set(legalSuffixes.map((s) => s.toLowerCase()));
  const words = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("en")
    .replace(/&/g, " and ")
    .replace(/\b([a-z])\./g, "$1")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let strippedSuffix = false;
  while (words.length > 1) {
    const last = words[words.length - 1] as string;
    if (suffixes.has(last)) {
      words.pop();
      strippedSuffix = true;
    } else if (last === "and" && strippedSuffix) {
      words.pop();
    } else {
      break;
    }
  }
  return words.join("-");
}

/** `normalizeTitle` of key version 1, frozen: tells which stored title keys version 2 changes. */
export function legacyTitleKey(title: string): string {
  return title
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(LEGACY_GENDER_MARKER, " ")
    .replace(/[:*/]in(?:nen)?\b/giu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** The city slug of key version 1 (`slugify` of `geography.ts`), frozen: cities in another script all slugged as "". */
export function legacyCitySlug(value: string): string {
  return value
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
}

/** `resolveCompanyName(...).nameNorm` of key version 1: aliases looked up by their version 1 key. */
function legacyResolvedKey(name: string, config: PipelineConfig): string {
  const suffixes = config.company.legal_suffixes;
  const own = legacyCompanyKey(name.trim().replace(/\s+/g, " "), suffixes);
  for (const [canonical, aliases] of Object.entries(config.company.aliases)) {
    if (aliases.some((alias) => legacyCompanyKey(alias, suffixes) === own)) return legacyCompanyKey(canonical, suffixes);
  }
  return own;
}

/** Whether the text has a letter of a script other than Latin ("Mercari, Inc. (株式会社メルカリ)"). */
const hasNonLatinLetter = (text: string): boolean => /(?=\p{L})\P{Script=Latin}/u.test(text);

// ---------------------------------------------------------------- recompute the stored keys

export interface IdentityKeyRefreshResult {
  /** Companies that got the key version 2 gives their display name. */
  companiesRekeyed: number;
  /** Companies whose new key another row already had: folded into that row (same employer, two spellings of version 1). */
  companiesFolded: number;
  /**
   * Marked (watched / blacklisted) companies with a name in two scripts whose version 1 key (the Latin part, "mercari") now
   * belongs to the Latin spelling alone ("Mercari Inc."): a row with the same marks was added under that key.
   */
  companiesKeptUnderLatinKey: number;
  /** Jobs whose title key changed. */
  jobsRekeyed: number;
  aborted: boolean;
}

export interface IdentityKeyRefreshOptions {
  config: PipelineConfig;
  logger: ChannelLogger;
  signal?: AbortSignal;
}

/**
 * Recompute the stored keys that key version 2 changes. Only a row whose stored key is what version 1 gives (for a company:
 * its display name, with the current legal forms) and whose version 2 key differs is touched, so a database whose names and
 * titles are all in Latin script stays exactly as it is. A company whose new key another row already holds is folded into
 * that row (`foldCompanyInto`: its jobs, salary lookups, aliases and marks move); when that row is itself waiting for a new
 * key, it moves first. Salary lookups follow the new company and title keys.
 *
 * A watched or blacklisted company whose name mixes scripts keeps its marks for both spellings: under version 1 the Latin
 * spelling of the same employer had the same key, so a row with the same marks (and each other's name as alias) is kept
 * under the old key.
 *
 * Jobs that version 1 merged under one key (two employers under the company keyed "", two roles under the title key "") stay
 * merged: `pnpm reprocess --split-merged` separates them (`splitMergedJobs`).
 */
export async function refreshIdentityKeys(db: Db, options: IdentityKeyRefreshOptions): Promise<IdentityKeyRefreshResult> {
  const result: IdentityKeyRefreshResult = { companiesRekeyed: 0, companiesFolded: 0, companiesKeptUnderLatinKey: 0, jobsRekeyed: 0, aborted: false };
  const suffixes = options.config.company.legal_suffixes;

  const rows = await listCompanyKeys(db);
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const idByKey = new Map(rows.map((row) => [row.nameNorm, row.id]));
  const pending = new Map<number, { from: string; to: string }>();
  for (const row of rows) {
    if (row.nameNorm !== legacyCompanyKey(row.name, suffixes)) continue; // a key from an alias or an older config: not this change
    const next = normalizeCompanyKey(row.name, suffixes);
    if (next !== row.nameNorm) pending.set(row.id, { from: row.nameNorm, to: next });
  }
  while (pending.size > 0) {
    let progressed = false;
    for (const [id, move] of pending) {
      if (options.signal?.aborted) return { ...result, aborted: true };
      const holder = idByKey.get(move.to);
      if (holder !== undefined && pending.has(holder)) continue; // that row moves away first
      if (holder === undefined) {
        const row = rowById.get(id)!;
        // a marked company named in two scripts keeps its marks for its Latin spelling: the row for that spelling is made in
        // the same transaction as the new key, so an interruption leaves both or neither
        const keepLatin =
          move.from !== "" && (row.watched || row.blacklisted) && hasNonLatinLetter(row.name) && ![...pending.values()].some((other) => other.to === move.from);
        const latinName = keepLatin ? (latinSpelling(row.name, move.from, suffixes) ?? row.name) : null;
        const sibling = await db.transaction(async (tx) => {
          if (!(await setCompanyNameNorm(tx, id, move.from, move.to))) throw new Error(`company ${id} changed its key while the keys were recomputed`);
          if (latinName === null) return null;
          const created = await insertCompanyIfAbsent(tx, { name: latinName, nameNorm: move.from, aliases: latinName === row.name ? [] : [row.name], watched: row.watched, blacklisted: row.blacklisted });
          if (created !== null && latinName !== row.name) await addCompanyAlias(tx, id, latinName);
          return created;
        });
        idByKey.set(move.to, id);
        result.companiesRekeyed += 1;
        if (idByKey.get(move.from) === id) idByKey.delete(move.from);
        if (sibling !== null) {
          idByKey.set(move.from, sibling);
          result.companiesKeptUnderLatinKey += 1;
          options.logger.warn("a marked company with a name in two scripts now has a row per spelling", { company: row.name, latinSpelling: latinName });
        }
      } else {
        await db.transaction((tx) => foldCompanyInto(tx, id, holder));
        result.companiesFolded += 1;
        if (idByKey.get(move.from) === id) idByKey.delete(move.from);
      }
      pending.delete(id);
      progressed = true;
    }
    if (!progressed) throw new Error(`company keys wait for each other (${pending.size} companies)`);
  }

  let afterId = 0;
  for (;;) {
    if (options.signal?.aborted) return { ...result, aborted: true };
    const batch = await listJobTitleKeys(db, { afterId, limit: options.config.batch_size });
    if (batch.length === 0) break;
    afterId = batch[batch.length - 1]!.id;
    const changed: Array<{ id: number; title: string; titleNorm: string; from: string }> = [];
    for (const job of batch) {
      const next = normalizeTitle(job.title);
      if (next !== job.titleNorm && next !== legacyTitleKey(job.title)) changed.push({ id: job.id, title: job.title, titleNorm: next, from: job.titleNorm });
    }
    if (changed.length === 0) continue;
    await db.transaction(async (tx) => {
      const written = new Set(await setJobTitleNorms(tx, changed));
      await rekeySalaryLookupTitles(tx, changed.filter((job) => written.has(job.id)).map((job) => ({ jobId: job.id, from: job.from, to: job.titleNorm })));
      result.jobsRekeyed += written.size;
    });
  }
  return result;
}

/** The name with its words in other scripts left out ("Mercari, Inc. (株式会社メルカリ)" -> "Mercari, Inc."), when that has `key`. */
function latinSpelling(name: string, key: string, suffixes: readonly string[]): string | null {
  const latin = name
    .replace(/[^\s\p{Script=Latin}\p{N}\p{P}\p{S}]+/gu, " ")
    .replace(/[([{]\s*[)\]}]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[\s,;:/-]+$/u, "")
    .trim();
  return latin !== "" && normalizeCompanyKey(latin, suffixes) === key ? latin : null;
}

/** `refreshIdentityKeys` once per key version: when the version stored by the last complete run differs (or `force`). */
export async function refreshIdentityKeysIfStale(db: Db, options: IdentityKeyRefreshOptions & { force?: boolean }): Promise<IdentityKeyRefreshResult | null> {
  const row = await getRuntimeState(db, IDENTITY_KEYS_STATE_KEY);
  if (!options.force && row?.value === IDENTITY_KEYS_VERSION) return null;
  const result = await refreshIdentityKeys(db, options);
  if (!result.aborted) {
    await setRuntimeState(db, IDENTITY_KEYS_STATE_KEY, IDENTITY_KEYS_VERSION);
    if (result.companiesRekeyed + result.companiesFolded + result.jobsRekeyed > 0) options.logger.info("company and title keys recomputed", { ...result });
  }
  return result;
}

// ---------------------------------------------------------------- split what version 1 merged

export interface SplitMergedResult {
  /** Jobs with a posting whose company, title or city key version 2 changes. */
  jobsChecked: number;
  /** Of those, jobs that lost postings which only version 1 had filed with them. */
  jobsSplit: number;
  sourcesUnlinked: number;
  /** Raw postings put back to `pending`, so the next pipeline run files each under its own keys. */
  rawRequeued: number;
  /** Split jobs the user had acted on (application, favourite, override): worth a look. Their company is unchanged. */
  splitWithUserState: number[];
  /** Jobs left unchanged for manual review: an unreadable linked posting or a company move that would affect user state. */
  needsReview: number[];
  aborted: boolean;
}

export interface PostingIdentity {
  companyName: string;
  title: string;
  locations: JobLocation[];
  /** The posting's cities (normalized, as the exact match compares them). */
  cities: string[];
}

export interface SplitMergedOptions {
  config: PipelineConfig;
  /** A raw posting -> the company name, cleaned title and cities the pipeline reads from it; `undefined` when it cannot be parsed. */
  identityOf: (raw: RawPosting) => PostingIdentity | undefined;
  logger: ChannelLogger;
  signal?: AbortSignal;
}

interface ExactKey {
  company: string;
  title: string;
  cities: Set<string>;
}

/**
 * The exact-match rule of `findMatchingJob` (same company, same title, same city or neither has one), on these keys. Version 1
 * also matched two empty titles; version 2 never does (`emptyTitleMatches`).
 */
function sameExactKey(a: ExactKey, b: ExactKey, emptyTitleMatches: boolean): boolean {
  if (a.company !== b.company || a.title !== b.title || (a.title === "" && !emptyTitleMatches)) return false;
  if (a.cities.size === 0 && b.cities.size === 0) return true;
  for (const city of a.cities) if (b.cities.has(city)) return true;
  return false;
}

/**
 * One-off repair of jobs that key version 1 merged by mistake. A job is checked when one of its postings has a company,
 * title or city whose key version 2 changes. Its anchor is the first posting (best apply-link priority) that has the job's
 * own company and title under version 2 (falling back to its title alone when the job holds nothing the user did). A
 * posting is detached when version 1 gave it the anchor's exact key and version 2 does not: only what the old keys merged,
 * never what the same-source or SimHash pass merged. Detached postings go back to `pending` and the next pipeline run
 * (`pnpm reprocess`) files each under its own company and title. When the anchor names another company than the job's,
 * the job's postings go back too, so the job moves to that company; never a job the user acted on (it is listed instead).
 * Run `refreshIdentityKeys` first.
 */
export async function splitMergedJobs(db: Db, options: SplitMergedOptions): Promise<SplitMergedResult> {
  const result: SplitMergedResult = { jobsChecked: 0, jobsSplit: 0, sourcesUnlinked: 0, rawRequeued: 0, splitWithUserState: [], needsReview: [], aborted: false };
  const { config } = options;
  const suffixes = config.company.legal_suffixes;
  const companyKeyById = new Map((await listCompanyKeys(db)).map((row) => [row.id, row.nameNorm]));
  const v1 = (identity: PostingIdentity): ExactKey => ({
    company: legacyResolvedKey(identity.companyName, config),
    title: legacyTitleKey(identity.title),
    cities: new Set(identity.cities.map(legacyCitySlug)),
  });
  const v2 = (identity: PostingIdentity): ExactKey => ({
    company: resolveCompanyName(identity.companyName, config).nameNorm,
    title: normalizeTitle(identity.title),
    cities: new Set(identity.cities.map(slugify)),
  });
  const changedByVersion2 = (identity: PostingIdentity): boolean =>
    legacyCompanyKey(identity.companyName, suffixes) !== normalizeCompanyKey(identity.companyName, suffixes) ||
    legacyTitleKey(identity.title) !== normalizeTitle(identity.title) ||
    identity.cities.some((city) => legacyCitySlug(city) !== slugify(city));

  let afterId = 0;
  for (;;) {
    const batch = await listJobsWithRawPostings(db, { afterId, limit: config.batch_size, includeUnparsed: true });
    if (batch.length === 0) break;
    const acted = await jobIdsWithUserState(db, batch.map((job) => job.jobId));
    for (const job of batch) {
      if (options.signal?.aborted) return { ...result, aborted: true };
      afterId = job.jobId;
      const unreadable: number[] = [];
      const sources = job.sources.flatMap((source) => {
        const identity = options.identityOf(source.raw);
        if (identity === undefined) {
          unreadable.push(source.raw.id);
          return [];
        }
        return [{ rawId: source.raw.id, identity, v1: v1(identity), v2: v2(identity) }];
      });
      if (!sources.some((source) => changedByVersion2(source.identity))) continue;
      result.jobsChecked += 1;
      if (unreadable.length > 0) {
        result.needsReview.push(job.jobId);
        options.logger.warn("merged job left unchanged because linked postings could not be parsed", { jobId: job.jobId, rawPostingIds: unreadable });
        continue;
      }

      const ownCompany = companyKeyById.get(job.companyId);
      const ownTitle = normalizeTitle(job.title);
      const userState = acted.has(job.jobId);
      let anchor = sources.find((source) => source.v2.company === ownCompany && source.v2.title === ownTitle);
      const moves = anchor === undefined;
      if (anchor === undefined && !userState) anchor = sources.find((source) => source.v2.title === ownTitle);
      if (anchor === undefined) {
        if (userState) result.needsReview.push(job.jobId);
        continue;
      }
      const reference = anchor;
      const detached = sources.filter((source) => source !== reference && sameExactKey(source.v1, reference.v1, true) && !sameExactKey(source.v2, reference.v2, false)).map((source) => source.rawId);
      const requeue = moves ? sources.map((source) => source.rawId) : detached;
      if (requeue.length === 0) continue;
      await db.transaction(async (tx) => {
        if (detached.length > 0) {
          result.sourcesUnlinked += await unlinkJobSources(tx, job.jobId, detached);
          // Locations accumulate during normal merges. Leaving a detached source's city here would make the exact-key
          // pass file it straight back into this job. Rebuild from every retained source, in apply-link priority order.
          const removed = new Set(detached);
          const locations = sources.filter((source) => !removed.has(source.rawId)).reduce<JobLocation[]>((all, source) => unionLocations(all, source.identity.locations), []);
          await updateJob(tx, job.jobId, { locationsJson: locations });
          result.jobsSplit += 1;
          if (userState) result.splitWithUserState.push(job.jobId);
        }
        result.rawRequeued += await requeueRawPostingsById(tx, requeue);
      });
    }
  }
  options.logger.info("merged jobs checked", { ...result });
  return result;
}

import type { ChannelLogger } from "@/lib/channels/types";
import type { PipelineConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { foldCompanyInto, listCompanyKeys, setCompanyNameNorm } from "@/lib/db/repos/companies";
import { listJobsWithRawPostings, unlinkJobSources } from "@/lib/db/repos/job-sources";
import { listJobTitleKeys, setJobTitleNorms } from "@/lib/db/repos/jobs";
import { requeueRawPostingsById, type RawPosting } from "@/lib/db/repos/raw-postings";
import { getRuntimeState, setRuntimeState } from "@/lib/db/repos/runtime-state";

import { normalizeCompanyKey, resolveCompanyName } from "./company";
import { normalizeTitle } from "./normalize";

/**
 * Version of the stored identity keys (`companies.name_norm`, `jobs.title_norm`). Version 2 keeps the letters and digits of
 * every script; version 1 kept only `a-z` / `0-9`, so a name or title in another script keyed as "" (or as its Latin part
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

// ---------------------------------------------------------------- recompute the stored keys

export interface IdentityKeyRefreshResult {
  /** Companies that got the key version 2 gives their display name. */
  companiesRekeyed: number;
  /** Companies whose new key another row already had: folded into that row (same employer, two spellings of version 1). */
  companiesFolded: number;
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
 * that row (`foldCompanyInto`); when that row is itself waiting for a new key, it moves first.
 *
 * Jobs that version 1 merged under one key (two employers under the company keyed "", two roles under the title key "") stay
 * merged: `pnpm reprocess --split-merged` separates them (`splitMergedJobs`).
 */
export async function refreshIdentityKeys(db: Db, options: IdentityKeyRefreshOptions): Promise<IdentityKeyRefreshResult> {
  const result: IdentityKeyRefreshResult = { companiesRekeyed: 0, companiesFolded: 0, jobsRekeyed: 0, aborted: false };
  const suffixes = options.config.company.legal_suffixes;

  const rows = await listCompanyKeys(db);
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
        await setCompanyNameNorm(db, id, move.to);
        idByKey.set(move.to, id);
        result.companiesRekeyed += 1;
      } else {
        await db.transaction((tx) => foldCompanyInto(tx, id, holder));
        result.companiesFolded += 1;
      }
      if (idByKey.get(move.from) === id) idByKey.delete(move.from);
      pending.delete(id);
      progressed = true;
    }
    if (!progressed) {
      // rows waiting for each other's key (not seen in practice): they keep their keys
      options.logger.warn("company keys left unchanged: they wait for each other", { companies: pending.size });
      break;
    }
  }

  let afterId = 0;
  for (;;) {
    if (options.signal?.aborted) return { ...result, aborted: true };
    const batch = await listJobTitleKeys(db, { afterId, limit: options.config.batch_size });
    if (batch.length === 0) break;
    afterId = batch[batch.length - 1]!.id;
    const changed: Array<{ id: number; titleNorm: string }> = [];
    for (const job of batch) {
      const next = normalizeTitle(job.title);
      if (next !== job.titleNorm && next !== legacyTitleKey(job.title)) changed.push({ id: job.id, titleNorm: next });
    }
    await setJobTitleNorms(db, changed);
    result.jobsRekeyed += changed.length;
  }
  return result;
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
  /** Jobs with a source whose company or title key version 2 changes. */
  jobsChecked: number;
  /** Of those, jobs whose sources name more than one company / title under version 2: the other postings were detached. */
  jobsSplit: number;
  sourcesUnlinked: number;
  /** Raw postings of the checked jobs put back to `pending`, so the next pipeline run files each under its own keys. */
  rawRequeued: number;
  aborted: boolean;
}

export interface SplitMergedOptions {
  config: PipelineConfig;
  /** A raw posting -> the company name and cleaned title the pipeline reads from it; `undefined` when it cannot be parsed. */
  identityOf: (raw: RawPosting) => { companyName: string; title: string } | undefined;
  logger: ChannelLogger;
  signal?: AbortSignal;
}

/**
 * One-off repair of jobs that key version 1 merged by mistake. A job is checked when one of its postings has a company name or
 * title whose key version 2 changes. Its postings are grouped by their version 2 keys (company, title); the group with the
 * job's own title stays linked, the postings of every other group are detached from the job, and all postings of the job go
 * back to `pending`. The next pipeline run (`pnpm reprocess`) then updates the job from its own postings (its company follows
 * them) and files each detached posting under its own company and title: as a job of its own, or merged again where the
 * same-source or SimHash pass says it is the same job. Run `refreshIdentityKeys` first.
 */
export async function splitMergedJobs(db: Db, options: SplitMergedOptions): Promise<SplitMergedResult> {
  const result: SplitMergedResult = { jobsChecked: 0, jobsSplit: 0, sourcesUnlinked: 0, rawRequeued: 0, aborted: false };
  const suffixes = options.config.company.legal_suffixes;
  const changedByVersion2 = (identity: { companyName: string; title: string }): boolean =>
    legacyCompanyKey(identity.companyName, suffixes) !== normalizeCompanyKey(identity.companyName, suffixes) ||
    legacyTitleKey(identity.title) !== normalizeTitle(identity.title);

  let afterId = 0;
  for (;;) {
    const batch = await listJobsWithRawPostings(db, { afterId, limit: options.config.batch_size });
    if (batch.length === 0) break;
    for (const job of batch) {
      if (options.signal?.aborted) return { ...result, aborted: true };
      afterId = job.jobId;
      const sources = job.sources.map((source) => ({ raw: source.raw, identity: options.identityOf(source.raw) }));
      if (!sources.some((source) => source.identity !== undefined && changedByVersion2(source.identity))) continue;
      result.jobsChecked += 1;

      const ownTitle = normalizeTitle(job.title);
      const groups = new Map<string, { titleNorm: string; rawIds: number[] }>();
      for (const { raw, identity } of sources) {
        if (identity === undefined) continue; // cannot be read again: stays where it is
        const titleNorm = normalizeTitle(identity.title);
        const key = JSON.stringify([resolveCompanyName(identity.companyName, options.config).nameNorm, titleNorm]);
        const group = groups.get(key) ?? { titleNorm, rawIds: [] };
        group.rawIds.push(raw.id);
        groups.set(key, group);
      }
      const kept = [...groups.values()].find((group) => group.titleNorm === ownTitle) ?? [...groups.values()][0];
      const detached = [...groups.values()].filter((group) => group !== kept).flatMap((group) => group.rawIds);
      await db.transaction(async (tx) => {
        if (detached.length > 0) {
          result.sourcesUnlinked += await unlinkJobSources(tx, job.jobId, detached);
          result.jobsSplit += 1;
        }
        result.rawRequeued += await requeueRawPostingsById(tx, sources.map((source) => source.raw.id));
      });
    }
  }
  options.logger.info("merged jobs checked", { ...result });
  return result;
}

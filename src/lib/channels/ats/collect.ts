/**
 * Shared ATS sweeps retain postings from complete and partial board reads. Each board is READ-COMPLETE,
 * SOFT (a short list, later-page 404, or non-200 2xx), or FAILED (a hard list error or unresolved details).
 * Only an all-FAILED sweep throws its first failed board's cause, wrapped in PartialCollectError when
 * postings were collected. A READ-COMPLETE or SOFT board lets the sweep return normally.
 */
import type { z } from "zod";

import { ChannelError, isAbortError, PartialCollectError, type ChannelErrorCode } from "@/lib/channels/errors";
import type {
  Channel,
  ChannelContext,
  DescriptionHtmlFragment,
  NormalizedPostingDraft,
  RawPostingInput,
  SearchQuery,
} from "@/lib/channels/types";
import type { AtsTitlePrefilterSettings, CompaniesConfig, CompanyEntry, InterestsConfig, SearchConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";

import { fetchBoardJson, type BoardFetch } from "./conditional";
import { wrapPosting, type AtsSource } from "./envelope";
import { createTitlePrefilter, type TitlePrefilter } from "./prefilter";
import type { AtsBoardStore } from "./store";

// Format version of the stored validator; bumping it discards ETags and id lists remembered under older semantics.
const BOARD_STATE_VERSION = "3";

// A host-level refusal stops remaining details immediately, independently of the failure threshold.
const HOST_LEVEL = new Set<ChannelErrorCode>(["blocked", "auth_expired", "rate_limited", "budget_exceeded"]);

export type AtsId = "greenhouse" | "lever" | "ashby" | "personio" | "smartrecruiters";

/** The parts of the config an ATS sweep reads. */
export interface AtsInputs {
  companies: CompaniesConfig;
  search: SearchConfig;
  interests: InterestsConfig;
}

export interface AtsDeps {
  /** Current config (re-read on every collect, so edits apply to the next cycle). */
  inputs(): AtsInputs;
  /** Board state storage; only asked for in real runs (dry runs neither read nor write it). */
  store(): AtsBoardStore;
}

/** One posting as the board listed it, reduced to what the sweep needs. */
export interface ListedPosting {
  externalId: string;
  title: string | null;
  url: string | null;
  postedAt: Date | null;
}

export interface AtsDetails<Settings> {
  /** False when settings turn details off; the stage is skipped and list entries are handed over. */
  enabled(settings: Settings): boolean;
  /** Completes a kept posting; null means it closed meanwhile (404). Throws ChannelError on failure. */
  enrich(ctx: ChannelContext, posting: unknown, company: CompanyEntry, settings: Settings): Promise<unknown | null>;
  /** Detail failures in a row after which the rest of this board's details are skipped (validated settings). */
  maxConsecutiveFailures(settings: Settings): number;
}

export interface AtsAdapter<Settings extends { title_prefilter: AtsTitlePrefilterSettings }> {
  readonly id: AtsId;
  /** Validates the channel's block of sources.yaml. */
  readonly settingsSchema: z.ZodType<Settings>;
  boardUrl(company: CompanyEntry, settings: Settings): string;
  /**
   * Replaces the default conditional JSON GET of `boardUrl` for boards that are not one JSON
   * document (XML, paged lists). Honour `etag` as `fetchBoardJson` does, retain content read before
   * a later-page failure, and report mutually exclusive `incomplete` or `shortfall` metadata.
   * `complete` is true only when neither is present; return an ETag only for a complete list.
   * Rethrow cancellation before classifying failures. List completeness does not cover details.
   */
  fetchBoard?(ctx: ChannelContext, company: CompanyEntry, settings: Settings, etag: string | null): Promise<BoardFetch>;
  /** The postings of a board response (`ChannelError("parse")` when the shape is wrong). */
  list(body: unknown): unknown[];
  /** null when a posting has no usable id (it cannot be stored). */
  describe(posting: unknown): ListedPosting | null;
  /**
   * Optional detail stage after the title prefilter and cap. Detail failures preserve stored payloads
   * and keep postings seen; retry state prioritizes new postings before stored ones and prior failures.
   */
  details?: AtsDetails<Settings>;
  /** Turn a stored payload (see envelope.ts) into the normalized shape; `ChannelError("parse")` on bad input. */
  parse(payload: unknown): NormalizedPostingDraft;
  /** The HTML parts of a stored payload (`Channel.descriptionHtml`); `[]` when it does not match. */
  descriptionHtml?(payload: unknown): DescriptionHtmlFragment[];
}

export type BoardOutcome = "changed" | "not_modified" | "not_found" | "error" | "incomplete" | "short";

/** What happened to one board in a sweep (logged per board; also the unit the tests look at). */
export interface BoardReport {
  company: string;
  board: string;
  outcome: BoardOutcome;
  /** Postings the board returned (0 for a 304: nothing was fetched). */
  fetched: number;
  /** Postings kept by the title prefilter and within max_results. */
  kept: number;
  /** Already-stored postings beyond the cap or missing details refreshed as seen. */
  touched?: number;
  duplicates?: number;
  detailFailed?: number;
  detailSkipped?: number;
  errorCode?: string;
}

export interface BoardCollection {
  report: BoardReport;
  postings: RawPostingInput[];
  /** The list failure behind an `error`, `not_found`, `incomplete`, or `short` report. */
  failure?: ChannelError;
  /** The list failure alone is soft; unresolved details still make the board FAILED. */
  soft?: boolean;
  /** First unresolved detail failure: prevents a complete read and makes the board FAILED. */
  detailFailure?: ChannelError;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

async function recordQuietly(
  ctx: ChannelContext,
  store: AtsBoardStore | null,
  key: { ats: string; token: string },
  update: Parameters<AtsBoardStore["record"]>[1],
): Promise<void> {
  if (!store) return;
  try {
    await store.record(key, update);
  } catch (error) {
    ctx.logger.warn("could not record ats board state", { board: key.token, error: errorMessage(error) });
  }
}

interface SweepContext<S extends { title_prefilter: AtsTitlePrefilterSettings }> {
  adapter: AtsAdapter<S>;
  settings: S;
  ctx: ChannelContext;
  store: AtsBoardStore | null;
  prefilter: TitlePrefilter;
  maxPerBoard: number;
}

/** Keep available postings and sightings, record list completeness and detail retries, and report failures to the sweep. */
export async function collectBoard<S extends { title_prefilter: AtsTitlePrefilterSettings }>(
  sweep: SweepContext<S>,
  company: CompanyEntry,
): Promise<BoardCollection> {
  const { adapter, ctx, store, prefilter } = sweep;
  const key = { ats: adapter.id, token: company.token };
  const url = adapter.boardUrl(company, sweep.settings);
  const fingerprint = `${BOARD_STATE_VERSION}:${prefilter.fingerprint(company.name)}:${sweep.maxPerBoard}`;
  const base = { company: company.name, board: company.token };

  const state = store ? await store.load(key) : null;
  if (store && state && !state.filterFingerprint?.startsWith(`${BOARD_STATE_VERSION}:`)) {
    // A rolled-back build can write legacy evidence after the one-shot reset migration has already run.
    try {
      await store.invalidateEvidence(key);
    } catch (error) {
      ctx.logger.warn("could not invalidate ats board evidence", { board: key.token, error: errorMessage(error) });
    }
  }
  // an ETag earned under other filter rules would hide postings the new rules want
  let etag = state && state.filterFingerprint === fingerprint ? state.etag : null;

  const fetchOnce = (validator: string | null): Promise<BoardFetch> =>
    adapter.fetchBoard ? adapter.fetchBoard(ctx, company, sweep.settings, validator) : fetchBoardJson(ctx, url, validator);

  let fetched = await fetchOnce(etag);
  ctx.signal.throwIfAborted();

  if (fetched.kind === "not_modified" && state && store) {
    // The board is unchanged, so its postings are still open: keep them "seen" (the lifecycle ages
    // out postings by last-seen time). If any of them never reached raw_postings (an earlier cycle
    // died between our request and the store), a 304 would hide them for good: ask again, unconditionally.
    const present = await store.touch(adapter.id, state.externalIds);
    if (present.length >= state.externalIds.length) {
      await recordQuietly(ctx, store, key, { status: "not_modified", completeRead: state.detailRetryIds.length === 0 });
      const count = state.detailRetryIds.length;
      if (count > 0) ctx.logger.warn("ats board still has unresolved details", { board: company.token, count });
      return {
        report: { ...base, outcome: "not_modified", fetched: 0, kept: 0 },
        postings: [],
        ...(count > 0 ? {
          detailFailure: new ChannelError("unknown", `${count} posting details are still missing from an earlier sweep`, { retryable: false }),
        } : {}),
      };
    }
    ctx.logger.warn("ats board unchanged but stored postings are missing; refetching", { board: company.token });
    etag = null;
    fetched = await fetchOnce(null);
    ctx.signal.throwIfAborted();
  }

  if (fetched.kind === "not_found") {
    const failure = new ChannelError("unknown", `board "${company.token}" not found (HTTP 404)`, { status: 404, retryable: false });
    await recordQuietly(ctx, store, key, { status: "error", errorCode: "not_found" });
    return { report: { ...base, outcome: "not_found", fetched: 0, kept: 0, errorCode: "not_found" }, postings: [], failure };
  }
  if (fetched.kind === "not_modified") {
    // a 304 to an unconditional request: the server broke the protocol
    throw new ChannelError("unknown", `board "${company.token}" answered 304 to an unconditional request`, { status: 304 });
  }

  const listed = adapter.list(fetched.body);
  const source: AtsSource = {
    ats: adapter.id,
    token: company.token,
    companyName: company.name,
    ...(company.region ? { region: company.region } : {}),
  };
  const keptPostings: Array<{ info: ListedPosting; posting: unknown }> = [];
  const listedIds = new Set<string>();
  const overCapIds: string[] = [];
  let unusable = 0;
  let duplicates = 0;
  for (const posting of listed) {
    const info = adapter.describe(posting);
    if (!info) {
      unusable += 1;
      continue;
    }
    if (listedIds.has(info.externalId)) {
      duplicates += 1;
      continue;
    }
    listedIds.add(info.externalId);
    // a posting without a title cannot be judged: keep it, the pipeline flags it parse_failed
    if (info.title !== null && !prefilter.decide(info.title, company.name).keep) continue;
    if (keptPostings.length >= sweep.maxPerBoard) {
      overCapIds.push(info.externalId);
      continue;
    }
    keptPostings.push({ info, posting });
  }
  // Refresh sightings before details: a later detail failure must not hide still-listed stored jobs.
  const overCapPresent = store && overCapIds.length > 0 ? await store.touch(adapter.id, overCapIds) : [];
  const present = new Set(overCapPresent);
  const oldRetryIds = new Set(state?.detailRetryIds ?? []);
  const failed = new Set<string>();
  const skipped = new Set<string>();
  const closed = new Set<string>();
  const completed = new Map<string, unknown>();
  let firstFailure: ChannelError | null = null;
  let stoppedBy: ChannelError | null = null;
  const details = adapter.details;
  if (details?.enabled(sweep.settings)) {
    const storedIds = new Set(state?.externalIds ?? []);
    const priority = (id: string): number => oldRetryIds.has(id) ? 2 : storedIds.has(id) ? 1 : 0;
    const ordered = state
      ? [...keptPostings].sort((a, b) => priority(a.info.externalId) - priority(b.info.externalId))
      : keptPostings;
    const limit = details.maxConsecutiveFailures(sweep.settings);
    let consecutive = 0;
    let requested = 0;
    for (const { info, posting } of ordered) {
      const id = info.externalId;
      if (stoppedBy) {
        skipped.add(id);
        continue;
      }
      ctx.signal.throwIfAborted();
      if (requested > 0) await ctx.throttle();
      requested += 1;
      let complete: unknown;
      try {
        complete = await details.enrich(ctx, posting, company, sweep.settings);
      } catch (error) {
        if (isAbortError(error) || ctx.signal.aborted) throw error;
        if (!(error instanceof ChannelError)) throw error;
        failed.add(id);
        firstFailure ??= error;
        if (HOST_LEVEL.has(error.code)) {
          stoppedBy = error;
          continue;
        }
        consecutive += 1;
        if (consecutive >= limit) stoppedBy = error;
        continue;
      }
      consecutive = 0;
      if (complete === null) {
        closed.add(id);
        continue;
      }
      completed.set(id, complete);
    }
    // The last detail may have been cancelled while its body was read.
    ctx.signal.throwIfAborted();
  }
  const detailMissing = [...failed, ...skipped];
  if (store && detailMissing.length > 0) {
    for (const id of await store.touch(adapter.id, detailMissing)) present.add(id);
  }
  // Only a complete list can resolve earlier retries; partial lists may omit still-unresolved ids.
  const detailRetryIds = fetched.incomplete || fetched.shortfall
    ? [...new Set([...oldRetryIds, ...failed, ...skipped])]
    : [...failed, ...[...oldRetryIds].filter((id) => skipped.has(id))];
  const firstMissing = detailMissing.some((id) => !present.has(id) && !oldRetryIds.has(id));
  const returned: RawPostingInput[] = [];
  // Request priority never changes the order in which the board's postings are handed over.
  for (const { info, posting } of keptPostings) {
    if (failed.has(info.externalId) || skipped.has(info.externalId) || closed.has(info.externalId)) continue;
    const complete = completed.has(info.externalId) ? completed.get(info.externalId) : posting;
    returned.push({ externalId: info.externalId, url: info.url, payload: wrapPosting(source, complete), postedAt: info.postedAt });
  }
  if (detailMissing.length > 0) {
    ctx.logger.warn("ats board details missing", {
      board: company.token,
      failed: failed.size,
      skipped: skipped.size,
      code: firstFailure?.code,
      ...(stoppedBy ? { stoppedBy: stoppedBy.code } : {}),
    });
  }
  if (unusable > 0) ctx.logger.warn("ats board postings without an id skipped", { board: company.token, count: unusable });
  if (overCapIds.length > 0) ctx.logger.warn("ats board capped at max_results", { board: company.token, dropped: overCapIds.length, cap: sweep.maxPerBoard, touched: overCapPresent.length });
  const result: BoardCollection = {
    report: {
      ...base,
      outcome: "changed",
      fetched: listed.length,
      kept: keptPostings.length,
      ...(present.size > 0 ? { touched: present.size } : {}),
      ...(duplicates > 0 ? { duplicates } : {}),
      ...(failed.size > 0 ? { detailFailed: failed.size } : {}),
      ...(skipped.size > 0 ? { detailSkipped: skipped.size } : {}),
    },
    postings: returned,
    ...(firstFailure ? { detailFailure: firstFailure } : {}),
  };
  if (fetched.incomplete) {
    const { cause, soft } = fetched.incomplete;
    await recordQuietly(ctx, store, key, { status: "error", errorCode: cause.code, detailRetryIds });
    ctx.logger.warn("ats board read only in part", { board: company.token, code: cause.code, listed: listed.length, kept: keptPostings.length });
    return { ...result, report: { ...result.report, outcome: "incomplete" }, failure: cause, soft };
  }
  if (fetched.shortfall) {
    const { listed, announced } = fetched.shortfall;
    await recordQuietly(ctx, store, key, { status: "short", detailRetryIds });
    ctx.logger.warn("ats board listed fewer than announced", { board: company.token, listed, announced });
    return {
      ...result,
      report: { ...result.report, outcome: "short" },
      failure: new ChannelError("unknown", `board listed ${listed} of ${announced} announced postings`),
      soft: true,
    };
  }
  await recordQuietly(ctx, store, key, {
    status: "ok",
    completeRead: detailMissing.length === 0,
    etag: firstMissing ? null : fetched.etag,
    filterFingerprint: fingerprint,
    externalIds: [...new Set([...returned.map((p) => p.externalId), ...present])],
    detailRetryIds,
    total: listed.length - duplicates,
    kept: keptPostings.length,
  });
  return result;
}

function parseSettings<S>(schema: z.ZodType<S>, extra: unknown, id: string): S {
  const parsed = schema.safeParse(extra);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(root)");
    throw new ChannelError("unknown", `sources.yaml block for ${id} is invalid (${paths.join(", ")})`, { retryable: false });
  }
  return parsed.data;
}

/**
 * An ATS channel: one sweep over every enabled board of `sources.yaml (ats_boards)` that uses this ATS. The
 * framework hands it the single keyword-less sweep query (`usesQueries: false`).
 *
 * Each attempted board is READ-COMPLETE (a complete list with resolved details, or a 304 with no
 * retries), SOFT (a short list, later-page 404, or non-200 2xx), or FAILED (a hard list failure,
 * including a missing board, or any unresolved details). Detail failures override soft list outcomes.
 * Failures preserve available postings and sightings and do not stop other boards. If every board
 * is FAILED, throw the first FAILED board's cause, wrapped in PartialCollectError when postings were
 * collected. Otherwise return all collected postings, even when that list is empty. Soft failures
 * are logged but never thrown.
 */
export function createAtsChannel<S extends { title_prefilter: AtsTitlePrefilterSettings }>(
  adapter: AtsAdapter<S>,
  deps: AtsDeps,
): Channel {
  return {
    id: adapter.id,
    family: "ats",
    kind: "ats",
    usesQueries: false,
    // the ghost job check: a board keeps one id per posting, stores the full text and its own publish date
    stableExternalIds: true,
    fullDescription: true,
    trustedPostedAt: true,
    async collect(query: SearchQuery, ctx: ChannelContext): Promise<RawPostingInput[]> {
      const settings = parseSettings(adapter.settingsSchema, ctx.settings.extra, adapter.id);
      const inputs = deps.inputs();
      const companies = inputs.companies.companies.filter((c) => c.enabled && c.ats === adapter.id);
      if (companies.length === 0) {
        ctx.logger.info("no enabled boards for this ats", { ats: adapter.id });
        return [];
      }
      // dry runs (no cycle id) write nothing and must show the whole board, so they skip the stored ETags
      const store = ctx.cycle.id === null ? null : deps.store();
      const sweep: SweepContext<S> = {
        adapter,
        settings,
        ctx,
        store,
        prefilter: createTitlePrefilter({
          settings: settings.title_prefilter,
          keywordGroups: inputs.search.keyword_groups,
          watchedCompanies: inputs.interests.watched_companies,
          pipeline: loadPipeline(),
        }),
        maxPerBoard: Math.min(query.maxResults, ctx.settings.maxResults),
      };

      const postings: RawPostingInput[] = [];
      const failures: ChannelError[] = [];
      let detailFailedBoards = 0;
      let softBoards = 0;
      let attempted = 0;
      for (const company of companies) {
        ctx.signal.throwIfAborted();
        if (attempted > 0) await ctx.throttle();
        attempted += 1;
        let result: BoardCollection;
        try {
          result = await collectBoard(sweep, company);
        } catch (error) {
          if (isAbortError(error) || ctx.signal.aborted) throw error;
          const failure = error instanceof ChannelError ? error : new ChannelError("unknown", errorMessage(error).slice(0, 300), { cause: error });
          await recordQuietly(ctx, store, { ats: adapter.id, token: company.token }, { status: "error", errorCode: failure.code });
          ctx.logger.warn("ats board failed", { company: company.name, board: company.token, code: failure.code, status: failure.status });
          failures.push(failure);
          continue;
        }
        const { report } = result;
        if (result.failure && !result.soft) {
          failures.push(result.failure);
        } else if (result.detailFailure) {
          failures.push(result.detailFailure);
          detailFailedBoards += 1;
        } else if (result.soft) {
          softBoards += 1;
        }
        if (report.outcome === "not_found") {
          ctx.logger.warn("ats board not found", { company: report.company, board: report.board });
        } else {
          ctx.logger.info("ats board", { ...report });
        }
        postings.push(...result.postings);
      }

      ctx.logger.info("ats sweep done", {
        ats: adapter.id,
        boards: attempted,
        failedBoards: failures.length - detailFailedBoards,
        ...(detailFailedBoards > 0 ? { detailFailedBoards } : {}),
        ...(softBoards > 0 ? { softBoards } : {}),
        postings: postings.length,
      });
      const [first] = failures;
      if (first && failures.length === attempted) {
        if (postings.length > 0) throw new PartialCollectError(postings, first);
        throw first;
      }
      return postings;
    },
    parse(payload: unknown): NormalizedPostingDraft {
      return adapter.parse(payload);
    },
    ...(adapter.descriptionHtml ? { descriptionHtml: (payload: unknown) => adapter.descriptionHtml?.(payload) ?? [] } : {}),
  };
}

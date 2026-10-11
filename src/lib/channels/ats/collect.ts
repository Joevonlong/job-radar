import type { z } from "zod";

import { ChannelError, isAbortError } from "@/lib/channels/errors";
import type {
  Channel,
  ChannelContext,
  DescriptionHtmlFragment,
  NormalizedPostingDraft,
  RawPostingInput,
  SearchQuery,
} from "@/lib/channels/types";
import type { AtsTitlePrefilterSettings, CompaniesConfig, CompanyEntry, InterestsConfig, SearchConfig } from "@/lib/config";

import { fetchBoardJson, type BoardFetch } from "./conditional";
import { wrapPosting, type AtsSource } from "./envelope";
import { createTitlePrefilter, type TitlePrefilter } from "./prefilter";
import type { AtsBoardStore } from "./store";

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

export interface AtsAdapter<Settings extends { title_prefilter: AtsTitlePrefilterSettings }> {
  readonly id: AtsId;
  /** Validates the channel's block of sources.yaml. */
  readonly settingsSchema: z.ZodType<Settings>;
  boardUrl(company: CompanyEntry, settings: Settings): string;
  /**
   * Replaces the default conditional JSON GET of `boardUrl` for boards that are not one JSON
   * document (XML, paged lists). Must honour `etag` the same way `fetchBoardJson` does.
   */
  fetchBoard?(ctx: ChannelContext, company: CompanyEntry, settings: Settings, etag: string | null): Promise<BoardFetch>;
  /** The postings of a board response (`ChannelError("parse")` when the shape is wrong). */
  list(body: unknown): unknown[];
  /** null when a posting has no usable id (it cannot be stored). */
  describe(posting: unknown): ListedPosting | null;
  /**
   * Completes a kept posting before it is stored (the board list lacks the description). Called once
   * per kept posting, after the title prefilter. null drops the posting (it closed in the meantime).
   */
  enrich?(ctx: ChannelContext, posting: unknown, company: CompanyEntry, settings: Settings): Promise<unknown | null>;
  /** Turn a stored payload (see envelope.ts) into the normalized shape; `ChannelError("parse")` on bad input. */
  parse(payload: unknown): NormalizedPostingDraft;
  /** The HTML parts of a stored payload (`Channel.descriptionHtml`); `[]` when it does not match. */
  descriptionHtml?(payload: unknown): DescriptionHtmlFragment[];
}

export type BoardOutcome = "changed" | "not_modified" | "not_found" | "error";

/** What happened to one board in a sweep (logged per board; also the unit the tests look at). */
export interface BoardReport {
  company: string;
  board: string;
  outcome: BoardOutcome;
  /** Postings the board returned (0 for a 304: nothing was fetched). */
  fetched: number;
  /** Postings kept by the title prefilter (and the per-board cap). */
  kept: number;
  errorCode?: string;
}

export interface BoardCollection {
  report: BoardReport;
  postings: RawPostingInput[];
  /** The failure behind an `error` / `not_found` report. */
  failure?: ChannelError;
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

/** Fetch one board (conditionally), apply the prefilter, and remember what the next request needs. */
export async function collectBoard<S extends { title_prefilter: AtsTitlePrefilterSettings }>(
  sweep: SweepContext<S>,
  company: CompanyEntry,
): Promise<BoardCollection> {
  const { adapter, ctx, store, prefilter } = sweep;
  const key = { ats: adapter.id, token: company.token };
  const url = adapter.boardUrl(company, sweep.settings);
  const fingerprint = `${prefilter.fingerprint(company.name)}:${sweep.maxPerBoard}`;
  const base = { company: company.name, board: company.token };

  const state = store ? await store.load(key) : null;
  // an ETag earned under other filter rules would hide postings the new rules want
  let etag = state && state.filterFingerprint === fingerprint ? state.etag : null;

  const fetchOnce = (validator: string | null): Promise<BoardFetch> =>
    adapter.fetchBoard ? adapter.fetchBoard(ctx, company, sweep.settings, validator) : fetchBoardJson(ctx, url, validator);

  let fetched = await fetchOnce(etag);

  if (fetched.kind === "not_modified" && state && store) {
    // The board is unchanged, so its postings are still open: keep them "seen" (the lifecycle ages
    // out postings by last-seen time). If any of them never reached raw_postings (an earlier cycle
    // died between our request and the store), a 304 would hide them for good: ask again, unconditionally.
    const present = await store.touch(adapter.id, state.externalIds);
    if (present >= state.externalIds.length) {
      await recordQuietly(ctx, store, key, { status: "not_modified" });
      return { report: { ...base, outcome: "not_modified", fetched: 0, kept: 0 }, postings: [] };
    }
    ctx.logger.warn("ats board unchanged but stored postings are missing; refetching", { board: company.token });
    etag = null;
    fetched = await fetchOnce(null);
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
  let unusable = 0;
  let truncated = 0;
  for (const posting of listed) {
    const info = adapter.describe(posting);
    if (!info) {
      unusable += 1;
      continue;
    }
    // a posting without a title cannot be judged: keep it, the pipeline flags it parse_failed
    if (info.title !== null && !prefilter.decide(info.title, company.name).keep) continue;
    if (keptPostings.length >= sweep.maxPerBoard) {
      truncated += 1;
      continue;
    }
    keptPostings.push({ info, posting });
  }
  const kept: RawPostingInput[] = [];
  let detailed = 0;
  for (const { info, posting } of keptPostings) {
    let complete: unknown = posting;
    if (adapter.enrich) {
      ctx.signal.throwIfAborted();
      if (detailed > 0) await ctx.throttle();
      detailed += 1;
      const enriched = await adapter.enrich(ctx, posting, company, sweep.settings);
      if (enriched === null) continue;
      complete = enriched;
    }
    kept.push({ externalId: info.externalId, url: info.url, payload: wrapPosting(source, complete), postedAt: info.postedAt });
  }
  if (unusable > 0) ctx.logger.warn("ats board postings without an id skipped", { board: company.token, count: unusable });
  if (truncated > 0) ctx.logger.warn("ats board capped at max_results", { board: company.token, dropped: truncated, cap: sweep.maxPerBoard });
  if (!fetched.complete) ctx.logger.warn("ats board answered with a partial response", { board: company.token });

  await recordQuietly(ctx, store, key, {
    status: "ok",
    etag: fetched.etag,
    filterFingerprint: fingerprint,
    externalIds: kept.map((k) => k.externalId),
    total: listed.length,
    kept: kept.length,
  });
  return { report: { ...base, outcome: "changed", fetched: listed.length, kept: kept.length }, postings: kept };
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
 * C2 at board level: a board that fails (404, 5xx after retries, bad shape) does not stop the
 * others; the sweep only fails — with the first board's error — when every attempted board failed.
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
        }),
        maxPerBoard: Math.min(query.maxResults, ctx.settings.maxResults),
      };

      const postings: RawPostingInput[] = [];
      const failures: ChannelError[] = [];
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
        if (result.failure) {
          failures.push(result.failure);
          ctx.logger.warn("ats board not found", { company: report.company, board: report.board });
        } else {
          ctx.logger.info("ats board", { ...report });
        }
        postings.push(...result.postings);
      }

      ctx.logger.info("ats sweep done", { ats: adapter.id, boards: attempted, failedBoards: failures.length, postings: postings.length });
      const [first] = failures;
      if (first && failures.length === attempted) throw first;
      return postings;
    },
    parse(payload: unknown): NormalizedPostingDraft {
      return adapter.parse(payload);
    },
    ...(adapter.descriptionHtml ? { descriptionHtml: (payload: unknown) => adapter.descriptionHtml?.(payload) ?? [] } : {}),
  };
}

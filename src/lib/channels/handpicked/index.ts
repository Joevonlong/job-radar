import {
  handpickedSettingsSchema,
  loadCompanies,
  loadConfig,
  type CompaniesConfig,
  type HandpickedSettings,
  type InterestsConfig,
  type PipelineConfig,
  type SearchConfig,
} from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { loadPipeline } from "@/lib/market";

import { issuePaths } from "../ats/envelope";
import { createTitlePrefilter } from "../ats/prefilter";
import { harvestBoardLinks } from "../discovery/harvest";
import { knownBoardKeys } from "../discovery/shared";
import { createDbDiscoveryStore, type DiscoveryStore } from "../discovery/store";
import { ChannelError, settlePostings } from "../errors";
import { loadKnownDetails, storedDetailOf } from "../known";
import { marketForChannel } from "../market";
import type { Channel, ChannelContext, RawPostingInput, SearchQuery } from "../types";
import { fetchDetail, fetchIndex } from "./client";
import { handpickedDescriptionHtml, parseHandpickedPayload } from "./parse";
import { indexEntrySchema, storedPayloadSchema, type HandpickedIndexEntry } from "./schema";
import { buildPlaces, discoveryLinks, selectPostings, type SelectStats } from "./select";

export const HANDPICKED_CHANNEL_ID = "handpicked";

export { handpickedDescriptionHtml, parseHandpickedPayload } from "./parse";
export { detailUrl, fetchDetail, fetchIndex, indexUrl } from "./client";
export { buildPlaces, discoveryLinks, matchesPlace, selectPostings } from "./select";

/** The parts of the config a run reads besides its own block. */
export interface HandpickedInputs {
  search: SearchConfig;
  interests: InterestsConfig;
  /** The effective pipeline (market packs merged): the city spellings and company-name rules. */
  pipeline: PipelineConfig;
  companies: CompaniesConfig;
  /** The market's home country (ISO 3166-1 alpha-2). */
  country: string;
}

export interface HandpickedDeps {
  /** Current config (re-read on every collect, so edits apply to the next cycle). */
  inputs(): HandpickedInputs;
  /** Candidate storage and run marker; only asked for in real runs. */
  store(): DiscoveryStore;
  now?(): Date;
}

export const defaultHandpickedDeps: HandpickedDeps = {
  inputs: () => ({
    search: loadConfig("search"),
    interests: loadConfig("interests"),
    pipeline: loadPipeline(),
    companies: loadCompanies(),
    country: marketForChannel().country,
  }),
  store: () => createDbDiscoveryStore(getDb(), HANDPICKED_CHANNEL_ID),
};

function settingsOf(ctx: ChannelContext): HandpickedSettings {
  const parsed = handpickedSettingsSchema.safeParse(ctx.settings.extra);
  if (!parsed.success) {
    throw new ChannelError("unknown", `sources.yaml sources.handpicked is not usable (${issuePaths(parsed.error)})`, { retryable: false });
  }
  return parsed.data;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/** What one run saw, for the log line. */
interface RunStats extends SelectStats {
  invalid: number;
  duplicates: number;
  truncated: number;
  reused: number;
  fetched: number;
  deferred: number;
  gone: number;
  badDetail: number;
}

export function createHandpickedChannel(deps: HandpickedDeps = defaultHandpickedDeps): Channel {
  return {
    id: HANDPICKED_CHANNEL_ID,
    family: "handpicked",
    kind: "api",
    usesQueries: false,
    // the index is a snapshot of the last weeks, not a window that can be stretched
    supportsCatchUp: () => false,
    async collect(query: SearchQuery, ctx: ChannelContext): Promise<RawPostingInput[]> {
      const settings = settingsOf(ctx);
      const inputs = deps.inputs();
      const now = (deps.now ?? (() => new Date()))();
      const prefilter = createTitlePrefilter({
        settings: settings.title_prefilter,
        keywordGroups: inputs.search.keyword_groups,
        watchedCompanies: inputs.interests.watched_companies,
        pipeline: inputs.pipeline,
      });
      const places = buildPlaces({ locations: inputs.search.locations, cityAliases: inputs.pipeline.filter.city_aliases, remoteScope: inputs.search.remote_scope, country: inputs.country });
      const known = knownBoardKeys(inputs.companies);

      ctx.signal.throwIfAborted();
      const rawEntries = await fetchIndex(ctx, settings);
      if (rawEntries.length === 0) ctx.logger.warn("handpicked index is empty");

      // each entry on its own: one that does not match the shape costs only itself; the id is unique, the first one wins
      let invalid = 0;
      let duplicates = 0;
      const seen = new Set<string>();
      const entries: Array<{ entry: HandpickedIndexEntry; raw: unknown }> = [];
      for (const raw of rawEntries) {
        const parsed = indexEntrySchema.safeParse(raw);
        if (!parsed.success) {
          invalid += 1;
          continue;
        }
        if (seen.has(parsed.data.id)) {
          duplicates += 1;
          continue;
        }
        seen.add(parsed.data.id);
        entries.push({ entry: parsed.data, raw });
      }
      if (invalid > 0) ctx.logger.warn("handpicked index entries of an unexpected shape skipped", { count: invalid });
      const rawOf = new Map(entries.map((e) => [e.entry.id, e.raw]));
      const all = entries.map((e) => e.entry);

      const { selected, stats: selectStats } = selectPostings(all, { places, maxAgeDays: settings.max_age_days, now, prefilter, known, skipKnownBoards: settings.skip_known_boards });
      const cap = Math.min(query.maxResults, ctx.settings.maxResults);
      const picked = selected.slice(0, cap);
      const stats: RunStats = { ...selectStats, invalid, duplicates, truncated: selected.length - picked.length, reused: 0, fetched: 0, deferred: 0, gone: 0, badDetail: 0 };

      // postings stored before keep their stored detail; only new ones cost a request
      const stored = await loadKnownDetails(ctx, {
        enabled: true,
        externalIds: picked.map((p) => p.entry.id),
        detailOf: storedDetailOf<unknown>(storedPayloadSchema),
      });
      const details = new Map<string, unknown>();
      for (const [id, detail] of stored) details.set(id, detail);
      stats.reused = details.size;

      let interrupted: ChannelError | null = null;
      for (const { entry } of picked) {
        if (details.has(entry.id)) continue;
        ctx.signal.throwIfAborted();
        if (stats.fetched >= settings.max_details_per_run) {
          stats.deferred += 1;
          continue;
        }
        if (interrupted) continue;
        if (stats.fetched > 0) await ctx.throttle();
        stats.fetched += 1;
        try {
          const result = await fetchDetail(ctx, settings, entry.id);
          if (result === null) stats.gone += 1;
          else details.set(entry.id, result.raw);
        } catch (error) {
          if (!(error instanceof ChannelError)) throw error;
          if (error.code === "parse") {
            stats.badDetail += 1;
            continue;
          }
          // a failing detail ends the fetching; what was fetched so far is kept and handed on with the failure
          interrupted = error;
        }
      }
      if (stats.gone > 0) ctx.logger.warn("handpicked postings withdrawn from the site skipped", { count: stats.gone });
      if (stats.badDetail > 0) ctx.logger.warn("handpicked posting details of an unexpected shape skipped", { count: stats.badDetail });
      if (stats.deferred > 0) ctx.logger.info("handpicked postings deferred to the next run", { count: stats.deferred, perRun: settings.max_details_per_run });

      const postings: RawPostingInput[] = [];
      for (const { entry, postedAt } of picked) {
        const detail = details.get(entry.id);
        if (detail === undefined) continue;
        postings.push({ externalId: entry.id, url: entry.url, payload: { index: rawOf.get(entry.id), detail }, postedAt });
      }

      // company discovery reads the same index; it never costs the postings (C2)
      let candidates: number | null = null;
      if (settings.discover_boards.enabled) {
        try {
          const store = ctx.cycle.id === null ? null : deps.store();
          const result = await harvestBoardLinks({
            provider: HANDPICKED_CHANNEL_ID,
            links: discoveryLinks(all, { places, prefilter, requireTitleMatch: settings.discover_boards.require_title_match }),
            known,
            store,
            intervalHours: settings.discover_boards.interval_hours,
            now,
            logger: ctx.logger,
          });
          candidates = result.candidates.length;
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          ctx.logger.warn("handpicked discovery failed", { error: errorMessage(error).slice(0, 300) });
        }
      }

      if (interrupted && postings.length === 0) throw interrupted;
      ctx.logger.info("handpicked run done", { ...stats, postings: postings.length, candidates, interrupted: interrupted?.code });
      return settlePostings(ctx.budget, postings, interrupted);
    },
    parse: parseHandpickedPayload,
    descriptionHtml: handpickedDescriptionHtml,
  };
}

export const handpickedChannel: Channel = createHandpickedChannel();

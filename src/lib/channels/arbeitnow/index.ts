import { arbeitnowSettingsSchema, loadConfig, type ArbeitnowSettings, type InterestsConfig, type SearchConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";

import { issuePaths } from "../ats/envelope";
import { createTitlePrefilter } from "../ats/prefilter";
import { ChannelError, settlePostings } from "../errors";
import type { Channel, ChannelContext, RawPostingInput, SearchQuery } from "../types";
import { fetchPage } from "./client";
import { arbeitnowDescriptionHtml, fromUnixSeconds, parseArbeitnowPayload } from "./parse";
import { jobSchema, type ArbeitnowJob } from "./schema";

export const ARBEITNOW_CHANNEL_ID = "arbeitnow";

export { arbeitnowDescriptionHtml, parseArbeitnowPayload } from "./parse";
export { fetchPage, pageUrl } from "./client";

/** The parts of the config a sweep reads besides its own block. */
export interface ArbeitnowInputs {
  search: SearchConfig;
  interests: InterestsConfig;
}

export interface ArbeitnowDeps {
  /** Current config (re-read on every collect, so edits apply to the next cycle). */
  inputs(): ArbeitnowInputs;
  /** The clock the look-back window is measured from. */
  now?(): Date;
}

export const defaultArbeitnowDeps: ArbeitnowDeps = {
  inputs: () => ({ search: loadConfig("search"), interests: loadConfig("interests") }),
};

function settingsOf(ctx: ChannelContext): ArbeitnowSettings {
  const parsed = arbeitnowSettingsSchema.safeParse(ctx.settings.extra);
  if (!parsed.success) {
    throw new ChannelError("unknown", `sources.yaml sources.arbeitnow is not usable (${issuePaths(parsed.error)})`, { retryable: false });
  }
  return parsed.data;
}

/** What one sweep saw, for the log line (and the tests). */
export interface SweepStats {
  pages: number;
  listed: number;
  invalid: number;
  duplicates: number;
  outsideWindow: number;
  prefiltered: number;
  truncated: number;
}

/**
 * One sweep over the newest pages of the board. The API takes no keywords or places, so the framework hands the channel its
 * single keyword-less sweep query (`usesQueries: false`), and the title prefilter decides what is stored (as for ATS boards).
 *
 * Pages are cached one by one at different times and are not sorted inside, so: postings are de-duplicated by `slug`, each one
 * outside the look-back window is dropped on its own, and paging stops at the first page whose NEWEST posting is older than the
 * window (never judged by its first or last item), at an empty page, when `links.next` is empty, or after `max_pages`.
 */
async function sweep(
  query: SearchQuery,
  ctx: ChannelContext,
  deps: ArbeitnowDeps,
): Promise<{ postings: RawPostingInput[]; stats: SweepStats; interrupted: ChannelError | null }> {
  const settings = settingsOf(ctx);
  const inputs = deps.inputs();
  const prefilter = createTitlePrefilter({
    settings: settings.title_prefilter,
    keywordGroups: inputs.search.keyword_groups,
    watchedCompanies: inputs.interests.watched_companies,
    pipeline: loadPipeline(),
  });
  const windowStart = (deps.now?.() ?? new Date()).getTime() - query.windowHours * 3_600_000;
  const cap = Math.min(query.maxResults, ctx.settings.maxResults);
  const stats: SweepStats = { pages: 0, listed: 0, invalid: 0, duplicates: 0, outsideWindow: 0, prefiltered: 0, truncated: 0 };
  const seen = new Set<string>();
  const kept: Array<{ job: ArbeitnowJob; raw: unknown; postedAt: Date }> = [];
  // a failing page ends the sweep; the earlier pages are kept and handed on with the failure
  let interrupted: ChannelError | null = null;

  for (let page = 1; page <= settings.max_pages; page += 1) {
    ctx.signal.throwIfAborted();
    if (page > 1) await ctx.throttle();
    let body;
    try {
      body = await fetchPage(ctx, settings, page);
    } catch (error) {
      if (!(error instanceof ChannelError)) throw error;
      interrupted = error;
      break;
    }
    stats.pages += 1;
    if (body.data.length === 0) break;
    stats.listed += body.data.length;
    let newest = Number.NEGATIVE_INFINITY;
    for (const item of body.data) {
      const parsed = jobSchema.safeParse(item);
      // a date that is not Unix seconds (a string, milliseconds, out of range) makes the posting unusable: it must not
      // count as the page's newest either, or a millisecond value would look like the far future and keep paging going
      const postedAt = parsed.success ? fromUnixSeconds(parsed.data.created_at) : null;
      if (!parsed.success || postedAt === null) {
        stats.invalid += 1;
        continue;
      }
      const job = parsed.data;
      const postedMs = postedAt.getTime();
      newest = Math.max(newest, postedMs);
      if (seen.has(job.slug)) {
        stats.duplicates += 1;
        continue;
      }
      seen.add(job.slug);
      if (postedMs < windowStart) {
        stats.outsideWindow += 1;
        continue;
      }
      if (!prefilter.decide(job.title, job.company_name).keep) {
        stats.prefiltered += 1;
        continue;
      }
      kept.push({ job, raw: item, postedAt });
    }
    // a page without a usable posting has no "newest" either: it says nothing about the next one, so paging goes on
    if (newest !== Number.NEGATIVE_INFINITY && newest < windowStart) break;
    const next = body.links?.next;
    if (next === null || next === undefined || next.trim() === "") break;
  }

  // newest first, then the cap
  kept.sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());
  stats.truncated = Math.max(0, kept.length - cap);
  const postings = kept.slice(0, cap).map(
    ({ job, raw, postedAt }): RawPostingInput => ({
      externalId: job.slug,
      url: job.url ?? null,
      payload: raw,
      postedAt,
    }),
  );
  return { postings, stats, interrupted };
}

export function createArbeitnowChannel(deps: ArbeitnowDeps = defaultArbeitnowDeps): Channel {
  return {
    id: ARBEITNOW_CHANNEL_ID,
    family: "arbeitnow",
    kind: "api",
    usesQueries: false,
    async collect(query: SearchQuery, ctx: ChannelContext): Promise<RawPostingInput[]> {
      const { postings, stats, interrupted } = await sweep(query, ctx, deps);
      if (interrupted && postings.length === 0) throw interrupted;
      if (stats.invalid > 0) ctx.logger.warn("arbeitnow postings of an unexpected shape skipped", { count: stats.invalid });
      ctx.logger.info("arbeitnow sweep done", { ...stats, postings: postings.length, interrupted: interrupted?.code });
      return settlePostings(ctx.budget, postings, interrupted);
    },
    parse: parseArbeitnowPayload,
    descriptionHtml: arbeitnowDescriptionHtml,
  };
}

export const arbeitnowChannel: Channel = createArbeitnowChannel();

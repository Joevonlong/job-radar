import { berlinStartupJobsSettingsSchema, loadConfig, type BerlinStartupJobsSettings, type InterestsConfig, type SearchConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";

import { issuePaths } from "../ats/envelope";
import { createTitlePrefilter } from "../ats/prefilter";
import { ChannelError, settlePostings } from "../errors";
import type { Channel, ChannelContext, RawPostingInput, SearchQuery } from "../types";
import { fetchCompanies, fetchLocations, fetchPostsPage } from "./client";
import { berlinStartupJobsDescriptionHtml, companyOf, fromGmt, parseBerlinStartupJobsPayload, splitTitle, trimPost, unpublishDay } from "./parse";
import { postSchema, type BerlinStartupJobsPost, type BerlinStartupJobsTerm } from "./schema";

export const BERLINSTARTUPJOBS_CHANNEL_ID = "berlinstartupjobs";

export { berlinStartupJobsDescriptionHtml, parseBerlinStartupJobsPayload } from "./parse";
export { companyUrl, fetchPostsPage, locationUrl, postsUrl } from "./client";

/** The parts of the config a scan reads besides its own block. */
export interface BerlinStartupJobsInputs {
  search: SearchConfig;
  interests: InterestsConfig;
}

export interface BerlinStartupJobsDeps {
  /** Current config (re-read on every collect, so edits apply to the next cycle). */
  inputs(): BerlinStartupJobsInputs;
  /** The clock the age and expiry rules are measured from. */
  now?(): Date;
}

export const defaultBerlinStartupJobsDeps: BerlinStartupJobsDeps = {
  inputs: () => ({ search: loadConfig("search"), interests: loadConfig("interests") }),
};

function settingsOf(ctx: ChannelContext): BerlinStartupJobsSettings {
  const parsed = berlinStartupJobsSettingsSchema.safeParse(ctx.settings.extra);
  if (!parsed.success) {
    throw new ChannelError("unknown", `sources.yaml sources.berlinstartupjobs is not usable (${issuePaths(parsed.error)})`, { retryable: false });
  }
  return parsed.data;
}

/** What one scan saw, for the log line (and the tests). */
export interface ScanStats {
  pages: number;
  listed: number;
  invalid: number;
  duplicates: number;
  expired: number;
  tooOld: number;
  prefiltered: number;
  truncated: number;
}

interface Listed {
  post: BerlinStartupJobsPost;
  /** The post as it is stored: the whitelisted keys only. */
  stored: Record<string, unknown>;
  postedAt: Date;
}

const DAY_MS = 86_400_000;

/**
 * One scan of the whole board (it is small: a few pages), like an ATS board, not a window over the newest: pages are read until
 * the last one, posts are de-duplicated by `id`, the site's own expiry and the age cap drop stale ones, the company terms of the
 * rest are looked up (a watched company is matched by its name), the title prefilter decides, and the newest `max_results` are
 * stored. A failing page ends the scan; the earlier pages are kept and handed on with the failure. A failing term request fails
 * the run: a posting without its company or place would be stored half-finished.
 */
async function scan(
  query: SearchQuery,
  ctx: ChannelContext,
  deps: BerlinStartupJobsDeps,
): Promise<{ postings: RawPostingInput[]; stats: ScanStats; interrupted: ChannelError | null }> {
  const settings = settingsOf(ctx);
  const inputs = deps.inputs();
  const prefilter = createTitlePrefilter({
    settings: settings.title_prefilter,
    keywordGroups: inputs.search.keyword_groups,
    watchedCompanies: inputs.interests.watched_companies,
    pipeline: loadPipeline(),
  });
  const now = deps.now?.() ?? new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const oldest = now.getTime() - settings.max_age_days * DAY_MS;
  const cap = Math.min(query.maxResults, ctx.settings.maxResults);
  const stats: ScanStats = { pages: 0, listed: 0, invalid: 0, duplicates: 0, expired: 0, tooOld: 0, prefiltered: 0, truncated: 0 };
  const seen = new Set<number>();
  const fresh: Listed[] = [];
  let interrupted: ChannelError | null = null;

  for (let page = 1; page <= settings.max_pages; page += 1) {
    ctx.signal.throwIfAborted();
    if (page > 1) await ctx.throttle();
    let result;
    try {
      result = await fetchPostsPage(ctx, settings, page);
    } catch (error) {
      if (!(error instanceof ChannelError)) throw error;
      interrupted = error;
      break;
    }
    if (result.beyondEnd) break;
    stats.pages += 1;
    if (result.posts.length === 0) break;
    stats.listed += result.posts.length;
    for (const item of result.posts) {
      const parsed = postSchema.safeParse(item);
      const postedAt = parsed.success ? fromGmt(parsed.data.date_gmt) : null;
      if (!parsed.success || postedAt === null) {
        stats.invalid += 1;
        continue;
      }
      const post = parsed.data;
      if (seen.has(post.id)) {
        stats.duplicates += 1;
        continue;
      }
      seen.add(post.id);
      // the site keeps a post up after its own end date: not collecting it is not closing it
      const until = unpublishDay(post._unpublish_on);
      if (settings.skip_expired && until !== null && until.getTime() < todayUtc) {
        stats.expired += 1;
        continue;
      }
      if (postedAt.getTime() < oldest) {
        stats.tooOld += 1;
        continue;
      }
      fresh.push({ post, stored: trimPost(item), postedAt });
    }
    // the last page: the header says so, or (without it) a page that is not full
    if (result.totalPages !== null ? page >= result.totalPages : result.posts.length < settings.per_page) break;
  }

  // newest first: the prefilter and the cap keep the most recent
  fresh.sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());
  if (fresh.length === 0) return { postings: [], stats, interrupted };

  ctx.signal.throwIfAborted();
  const companyIds = [...new Set(fresh.flatMap((f) => f.post.job_company))];
  if (stats.pages > 0 && companyIds.length > 0) await ctx.throttle();
  const companies = new Map<number, BerlinStartupJobsTerm>((await fetchCompanies(ctx, settings, companyIds)).map((t) => [t.id, t]));
  const kept = fresh.filter((f) => {
    const company = companyOf(f.post.title.rendered, companies.get(f.post.job_company[0] ?? -1)) ?? "";
    const keep = prefilter.decide(splitTitle(f.post.title.rendered).role, company).keep;
    if (!keep) stats.prefiltered += 1;
    return keep;
  });
  stats.truncated = Math.max(0, kept.length - cap);
  const picked = kept.slice(0, cap);
  if (picked.length === 0) return { postings: [], stats, interrupted };

  ctx.signal.throwIfAborted();
  await ctx.throttle();
  const locations = new Map<number, BerlinStartupJobsTerm>((await fetchLocations(ctx, settings)).map((t) => [t.id, t]));
  const termsOf = (ids: readonly number[], dictionary: ReadonlyMap<number, BerlinStartupJobsTerm>): BerlinStartupJobsTerm[] =>
    ids.flatMap((id) => {
      const term = dictionary.get(id);
      return term ? [term] : [];
    });
  const postings = picked.map(
    ({ post, stored, postedAt }): RawPostingInput => ({
      externalId: String(post.id),
      url: post.link ?? null,
      payload: { post: stored, terms: { job_company: termsOf(post.job_company, companies), job_location: termsOf(post.job_location, locations) } },
      postedAt,
    }),
  );
  return { postings, stats, interrupted };
}

export function createBerlinStartupJobsChannel(deps: BerlinStartupJobsDeps = defaultBerlinStartupJobsDeps): Channel {
  return {
    id: BERLINSTARTUPJOBS_CHANNEL_ID,
    family: "berlinstartupjobs",
    kind: "api",
    usesQueries: false,
    // the whole board is read every run: a wider window would fetch nothing more
    supportsCatchUp: () => false,
    async collect(query: SearchQuery, ctx: ChannelContext): Promise<RawPostingInput[]> {
      const { postings, stats, interrupted } = await scan(query, ctx, deps);
      if (interrupted && postings.length === 0) throw interrupted;
      if (stats.invalid > 0) ctx.logger.warn("berlinstartupjobs posts of an unexpected shape skipped", { count: stats.invalid });
      ctx.logger.info("berlinstartupjobs scan done", { ...stats, postings: postings.length, interrupted: interrupted?.code });
      return settlePostings(ctx.budget, postings, interrupted);
    },
    parse: parseBerlinStartupJobsPayload,
    descriptionHtml: berlinStartupJobsDescriptionHtml,
  };
}

export const berlinStartupJobsChannel: Channel = createBerlinStartupJobsChannel();

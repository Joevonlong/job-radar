import { stepstoneSettingsSchema, type StepstoneSettings } from "@/lib/config";

import { checkDetailsReadable } from "../details";
import { ChannelError, settlePostings } from "../errors";
import type { Channel, ChannelContext, RawPostingInput, SearchQuery } from "../types";
import { createCycleCache } from "../web/cache";
import { createTitleFilter, interleave, isWithinWindow, parseDate, windowCutoff } from "../web/select";
import { loadKnownDetails, storedDetailOf } from "../known";
import { ANSWER_SECTIONS, fetchDetail, fetchSearchPage, postingUrl, searchUrl } from "./client";
import { parseStepstonePayload } from "./parse";
import { payloadSchema, type StepstoneDetail, type StepstoneListItem, type StepstonePayload } from "./schema";

export const STEPSTONE_CHANNEL_ID = "stepstone";

function settingsOf(ctx: ChannelContext): StepstoneSettings {
  const parsed = stepstoneSettingsSchema.safeParse(ctx.settings.extra);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(root)");
    throw new ChannelError("unknown", `sources.yaml sources.stepstone is not usable (${paths.join(", ")})`, { retryable: false });
  }
  return parsed.data;
}

export interface StepstoneDeps {
  now?: () => Date;
}

/** Details already fetched in this cycle (a posting is often hit by several queries). `null` = the page is gone. */
const detailsOfCycle = createCycleCache<StepstoneDetail | null>();

export function createStepstoneChannel(deps: StepstoneDeps = {}): Channel {
  const now = deps.now ?? (() => new Date());

  async function collect(query: SearchQuery, ctx: ChannelContext): Promise<RawPostingInput[]> {
    const settings = settingsOf(ctx);
    const location = query.remote ? null : query.location;
    const cutoff = windowCutoff(now(), query.windowHours);
    const keepTitle = createTitleFilter(settings.title_prefilter, query.keywords);
    let first = true;
    const pace = async (): Promise<void> => {
      if (!first) await ctx.throttle();
      first = false;
    };

    // ---- search: one request series per keyword. The page lists the answers (`main`) newest first, then
    // the loose matches (`semantic`) newest first; the `ag` filter already limits both to the look-back window
    // A failing page ends the search; what earlier pages (and keywords) returned is kept and handed on with the failure.
    const perKeyword: StepstoneListItem[][] = [];
    const stats = { pages: 0, results: 0, outsideSections: 0, outsideWindow: 0, titleRejected: 0 };
    let interrupted: ChannelError | null = null;
    search: for (const keyword of query.keywords) {
      const kept: StepstoneListItem[] = [];
      perKeyword.push(kept);
      for (let page = 1; page <= settings.max_pages && kept.length < query.maxResults; page += 1) {
        const url = searchUrl(settings, { keyword, location, windowHours: query.windowHours, page });
        if (url === null) {
          ctx.logger.warn("keyword cannot be searched on stepstone, skipped", { query: query.id });
          break;
        }
        await pace();
        let result;
        try {
          result = await fetchSearchPage(ctx, settings, url);
        } catch (error) {
          if (!(error instanceof ChannelError)) throw error;
          interrupted = error;
          break search;
        }
        stats.pages += 1;
        stats.results += result.items.length;
        for (const item of result.items) {
          if (!ANSWER_SECTIONS.has(item.section ?? "main")) {
            stats.outsideSections += 1;
            continue;
          }
          const posted = parseDate(item.datePosted);
          if (!isWithinWindow(posted, cutoff)) {
            stats.outsideWindow += 1;
            continue;
          }
          if (!keepTitle(item.title)) {
            stats.titleRejected += 1;
            continue;
          }
          kept.push(item);
        }
        const lastPage = result.pageCount !== null && page >= result.pageCount;
        if (result.items.length === 0 || lastPage) break;
      }
    }
    const selected = interleave(perKeyword, query.maxResults, (item) => String(item.id));
    if (interrupted && selected.length === 0) throw interrupted;

    // ---- details: the job description lives only on the posting page
    const cache = detailsOfCycle(ctx.signal);
    const details = new Map<number, StepstoneDetail>();
    let attempted = 0;
    let parseFailures = 0;
    let reused = 0;
    if (settings.fetch_details) {
      // postings already stored keep their stored detail; only the others open their page
      // an interrupted query never overwrites a stored detail with none, whatever reuse_known_details says
      const reuse = settings.reuse_known_details || interrupted !== null;
      const detailOf = storedDetailOf<StepstoneDetail>(payloadSchema);
      const known = await loadKnownDetails(ctx, { enabled: reuse, externalIds: selected.map((item) => String(item.id)), detailOf });
      for (const item of selected) {
        const stored = known.get(String(item.id));
        if (stored) details.set(item.id, stored);
      }
      reused = known.size;
      const toFetch = selected.filter((i) => !known.has(String(i.id))).slice(0, settings.max_details_per_query);
      for (const item of toFetch) {
        const url = postingUrl(settings, item);
        if (url === null) continue;
        const key = String(item.id);
        if (cache.has(key)) {
          const cached = cache.get(key);
          if (cached) details.set(item.id, cached);
          continue;
        }
        // after a failure no new request goes out: stored and already fetched details are kept, the rest stays list data
        if (interrupted) continue;
        await pace();
        attempted += 1;
        try {
          const detail = await fetchDetail(ctx, settings, url);
          cache.set(key, detail);
          if (detail) details.set(item.id, detail);
        } catch (error) {
          if (!(error instanceof ChannelError)) throw error;
          // a flaky or changed page only costs that description
          if (error.code === "network") {
            ctx.logger.warn("posting page unavailable, continuing with list data", { query: query.id, code: error.code, status: error.status });
            break;
          }
          if (error.code === "parse") {
            parseFailures += 1;
            ctx.logger.warn("posting page not readable, continuing with list data", { query: query.id, code: error.code });
            continue;
          }
          // a block or a throttle ends the query (the framework backs off); the list results read so far are kept
          // and handed on with the failure
          ctx.logger.warn("posting pages refused, continuing with list data", { query: query.id, code: error.code, status: error.status });
          interrupted = error;
        }
      }
      if (interrupted && !reuse) {
        const missing = selected.filter((i) => !details.has(i.id)).map((i) => String(i.id));
        const stored = await loadKnownDetails(ctx, { enabled: true, externalIds: missing, detailOf });
        for (const item of selected) {
          const detail = stored.get(String(item.id));
          if (detail) details.set(item.id, detail);
        }
      }
    }
    checkDetailsReadable(ctx.logger, "stepstone", query.id, { attempted, parseFailures });

    const postings = selected.flatMap((item): RawPostingInput[] => {
      const url = postingUrl(settings, item);
      if (url === null) return [];
      const payload: StepstonePayload = { url, list: item, detail: details.get(item.id) ?? null };
      return [{ externalId: String(item.id), url, payload, postedAt: parseDate(item.datePosted) }];
    });
    if (interrupted && postings.length === 0) throw interrupted;
    ctx.logger.info("stepstone query done", {
      query: query.id,
      ...stats,
      postings: postings.length,
      details: details.size,
      reusedDetails: reused,
      interrupted: interrupted?.code,
    });
    return settlePostings(ctx.budget, postings, interrupted);
  }

  return {
    id: STEPSTONE_CHANNEL_ID,
    family: "stepstone",
    kind: "guest",
    usesQueries: true,
    // the ghost job check: StepStone ids are stable and the detail page's full text is stored
    stableExternalIds: true,
    fullDescription: true,
    collect,
    parse: parseStepstonePayload,
  };
}

export const stepstoneChannel: Channel = createStepstoneChannel();

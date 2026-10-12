import { xingSettingsSchema, type XingSettings } from "@/lib/config";

import { ChannelError, settlePostings } from "../errors";
import type { Channel, ChannelContext, RawPostingInput, SearchQuery } from "../types";
import { createCycleCache } from "../web/cache";
import { createTitleFilter, interleave, isWithinWindow, parseDate, windowCutoff } from "../web/select";
import { loadKnownDetails, storedDetailOf } from "../known";
import { fetchDetail, fetchSearchPage, PAGE_SIZE, postingId, postingUrl, searchUrl } from "./client";
import { parseXingPayload } from "./parse";
import { payloadSchema, type XingDetail, type XingListItem, type XingPayload } from "./schema";

export const XING_CHANNEL_ID = "xing";

function settingsOf(ctx: ChannelContext): XingSettings {
  const parsed = xingSettingsSchema.safeParse(ctx.settings.extra);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(root)");
    throw new ChannelError("unknown", `sources.yaml sources.xing is not usable (${paths.join(", ")})`, { retryable: false });
  }
  return parsed.data;
}

export interface XingDeps {
  now?: () => Date;
}

/** Details already fetched in this cycle (a posting is often hit by several queries). `null` = the page is gone. */
const detailsOfCycle = createCycleCache<XingDetail | null>();

export function createXingChannel(deps: XingDeps = {}): Channel {
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

    // ---- search: one request series per keyword. XING ranks by relevance and has no date filter, so
    // the look-back window is applied to each result's last refresh instead.
    // A failing page ends the search; what earlier pages (and keywords) returned is kept and handed on with the failure.
    const perKeyword: XingListItem[][] = [];
    const stats = { pages: 0, results: 0, outsideWindow: 0, titleRejected: 0 };
    let interrupted: ChannelError | null = null;
    search: for (const keyword of query.keywords) {
      const kept: XingListItem[] = [];
      perKeyword.push(kept);
      for (let page = 1; page <= settings.max_pages && kept.length < query.maxResults; page += 1) {
        await pace();
        let result;
        try {
          result = await fetchSearchPage(ctx, settings, searchUrl(settings, { keyword, location, page }));
        } catch (error) {
          if (!(error instanceof ChannelError)) throw error;
          interrupted = error;
          break search;
        }
        stats.pages += 1;
        stats.results += result.items.length;
        for (const item of result.items) {
          if (!isWithinWindow(parseDate(item.refreshedAt), cutoff)) {
            stats.outsideWindow += 1;
            continue;
          }
          if (!keepTitle(item.title)) {
            stats.titleRejected += 1;
            continue;
          }
          kept.push(item);
        }
        const exhausted = result.items.length < PAGE_SIZE || (result.total !== null && page * PAGE_SIZE >= result.total);
        if (exhausted) break;
      }
    }
    const selected = interleave(perKeyword, query.maxResults, postingId);
    if (interrupted && selected.length === 0) throw interrupted;

    // ---- details: the job description lives only on the posting page
    const cache = detailsOfCycle(ctx.signal);
    const details = new Map<string, XingDetail>();
    let attempted = 0;
    let parseFailures = 0;
    let reused = 0;
    if (settings.fetch_details) {
      // postings already stored keep their stored detail; only the others open their page
      const known = await loadKnownDetails(ctx, {
        // an interrupted query never overwrites a stored detail with none, whatever reuse_known_details says
        enabled: settings.reuse_known_details || interrupted !== null,
        externalIds: selected.map(postingId),
        detailOf: storedDetailOf<XingDetail>(payloadSchema),
      });
      for (const [id, detail] of known) details.set(id, detail);
      reused = known.size;
      const toFetch = selected.filter((i) => !known.has(postingId(i))).slice(0, settings.max_details_per_query);
      for (const item of toFetch) {
        const url = postingUrl(settings, item);
        if (url === null) continue;
        const id = postingId(item);
        if (cache.has(id)) {
          const cached = cache.get(id);
          if (cached) details.set(id, cached);
          continue;
        }
        // after a failure no new request goes out: stored and already fetched details are kept, the rest stays list data
        if (interrupted) continue;
        await pace();
        attempted += 1;
        try {
          const detail = await fetchDetail(ctx, settings, url);
          cache.set(id, detail);
          if (detail) details.set(id, detail);
        } catch (error) {
          if (!(error instanceof ChannelError)) throw error;
          // a block or a throttle ends the query; a flaky or changed page only costs that description
          if (error.code === "network") {
            ctx.logger.warn("posting page unavailable, continuing with list data", { query: query.id, code: error.code, status: error.status });
            break;
          }
          if (error.code !== "parse") throw error;
          parseFailures += 1;
          ctx.logger.warn("posting page not readable, continuing with list data", { query: query.id, code: error.code });
        }
      }
    }
    if (attempted > 0 && parseFailures === attempted) {
      throw new ChannelError("parse", "xing: none of the posting pages could be read (page layout changed?)");
    }

    const postings = selected.flatMap((item): RawPostingInput[] => {
      const url = postingUrl(settings, item);
      if (url === null) return [];
      const id = postingId(item);
      const payload: XingPayload = { url, list: item, detail: details.get(id) ?? null };
      return [{ externalId: id, url, payload, postedAt: parseDate(item.refreshedAt) }];
    });
    if (interrupted && postings.length === 0) throw interrupted;
    ctx.logger.info("xing query done", {
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
    id: XING_CHANNEL_ID,
    family: "xing",
    kind: "guest",
    usesQueries: true,
    // the ghost job check: XING ids are stable and the full text is stored
    stableExternalIds: true,
    fullDescription: true,
    collect,
    parse: parseXingPayload,
  };
}

export const xingChannel: Channel = createXingChannel();

import { stepstoneSettingsSchema, type StepstoneSettings } from "@/lib/config";

import { detailLayoutError } from "../details";
import { ChannelError, settlePostings } from "../errors";
import type { Channel, ChannelContext, RawPostingInput, SearchQuery } from "../types";
import { createCycleCache } from "../web/cache";
import { createTitleFilter, interleave, isWithinWindow, parseDate, windowCutoff } from "../web/select";
import { loadKnownDetails, storedDetailOf } from "../known";
import { searchKind } from "../query";
import { ANSWER_SECTIONS, HOME_OFFICE_VALUES, fetchDetail, fetchSearchPage, postingUrl, searchUrl } from "./client";
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
    const kind = searchKind(query);
    const location = kind === "city" ? query.location : null;
    const cutoff = windowCutoff(now(), query.windowHours);
    // a company query searches an employer name: its title never contains it, and the later filters judge the jobs
    const keepTitle = kind === "company" ? () => true : createTitleFilter(settings.title_prefilter, query.keywords);
    let first = true;
    const pace = async (): Promise<void> => {
      if (!first) await ctx.throttle();
      first = false;
    };

    // ---- search: one request per keyword. robots.txt only permits `?q=` on a search URL, so there is no time sort, no `ag`
    // look-back filter, no radius and no paging: the page lists up to ~25 answers (`main`, then loose `semantic` matches) in StepStone's
    // order, and the look-back window is applied here from each posting's date.
    // A failing request ends the search; what earlier keywords returned is kept and handed on with the failure.
    const perKeyword: StepstoneListItem[][] = [];
    const stats = { pages: 0, results: 0, outsideSections: 0, notHomeOffice: 0, outsideWindow: 0, titleRejected: 0, availablePages: 0 };
    // listed answers older than the window that pass the other filters: a new one is not stored, but one that is already stored
    // is delivered again as it was stored, which moves its last-seen time (no further request)
    const older = new Map<string, StepstoneListItem>();
    let interrupted: ChannelError | null = null;
    search: for (const keyword of query.keywords) {
      const kept: StepstoneListItem[] = [];
      perKeyword.push(kept);
      const url = searchUrl(settings, { keyword, location, kind });
      if (url === null) {
        ctx.logger.warn("keyword cannot be searched on stepstone, skipped", { query: query.id });
        continue;
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
      stats.availablePages += result.pageCount ?? 0;
      for (const item of result.items) {
        if (!ANSWER_SECTIONS.has(item.section ?? "main")) {
          stats.outsideSections += 1;
          continue;
        }
        // the nationwide remote search cannot ask StepStone for home-office jobs (`wfh` is not permitted): filter here
        if (kind === "remote" && !HOME_OFFICE_VALUES.has(item.workFromHome ?? "")) {
          stats.notHomeOffice += 1;
          continue;
        }
        const posted = parseDate(item.datePosted);
        if (!isWithinWindow(posted, cutoff)) {
          stats.outsideWindow += 1;
          if (keepTitle(item.title)) older.set(String(item.id), item);
          continue;
        }
        if (!keepTitle(item.title)) {
          stats.titleRejected += 1;
          continue;
        }
        kept.push(item);
      }
    }
    const selected = interleave(perKeyword, query.maxResults, (item) => String(item.id));
    const selectedIds = new Set(selected.map((item) => String(item.id)));
    const refreshCandidates = [...older.values()].filter((item) => !selectedIds.has(String(item.id)));
    const storedOlder = await loadKnownDetails<unknown>(ctx, {
      enabled: true,
      externalIds: refreshCandidates.map((item) => String(item.id)),
      detailOf: (payload) => (payloadSchema.safeParse(payload).success ? payload : null),
    });
    const refreshed = refreshCandidates.flatMap((item): RawPostingInput[] => {
      const stored = storedOlder.get(String(item.id));
      const url = postingUrl(settings, item);
      if (stored === undefined || url === null) return [];
      return [{ externalId: String(item.id), url, payload: stored, postedAt: parseDate(item.datePosted) }];
    });
    if (interrupted && selected.length === 0 && refreshed.length === 0) throw interrupted;

    // ---- details: the job description lives only on the posting page
    const cache = detailsOfCycle(ctx.signal);
    const details = new Map<number, StepstoneDetail>();
    let attempted = 0;
    let parseFailures = 0;
    let reused = 0;
    let employerSkipped = 0;
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
      // company queries: another employer's page would be dropped afterwards, so it costs no request (it stays list data)
      const unknown = selected.filter((i) => !known.has(String(i.id)));
      const ofEmployer = unknown.filter((i) => ctx.employerMatches?.(i.companyName) ?? true);
      employerSkipped = unknown.length - ofEmployer.length;
      const toFetch = ofEmployer.slice(0, settings.max_details_per_query);
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
      // every posting page unreadable: the layout changed. The list results are still handed on, with that failure
      interrupted ??= detailLayoutError(ctx.logger, "stepstone", query.id, { attempted, parseFailures, maxPerQuery: settings.max_details_per_query });
      if (interrupted && !reuse) {
        const missing = selected.filter((i) => !details.has(i.id)).map((i) => String(i.id));
        const stored = await loadKnownDetails(ctx, { enabled: true, externalIds: missing, detailOf });
        for (const item of selected) {
          const detail = stored.get(String(item.id));
          if (detail) details.set(item.id, detail);
        }
      }
    }

    const postings = selected.flatMap((item): RawPostingInput[] => {
      const url = postingUrl(settings, item);
      if (url === null) return [];
      const payload: StepstonePayload = { url, list: item, detail: details.get(item.id) ?? null };
      return [{ externalId: String(item.id), url, payload, postedAt: parseDate(item.datePosted) }];
    });
    postings.push(...refreshed);
    if (interrupted && postings.length === 0) throw interrupted;
    if (postings.length === 0 && stats.outsideWindow > 0) {
      ctx.logger.info("stepstone query stored nothing: listed answers are older than the look-back window", {
        query: query.id,
        listed: stats.results,
        outsideWindow: stats.outsideWindow,
        windowHours: query.windowHours,
      });
    }
    // a run that stores nothing says why: outsideWindow is the number of listed answers the look-back window dropped
    ctx.logger.info("stepstone query done", {
      query: query.id,
      ...stats,
      postings: postings.length,
      refreshedStored: refreshed.length,
      details: details.size,
      reusedDetails: reused,
      ...(employerSkipped > 0 ? { otherEmployerDetailsSkipped: employerSkipped } : {}),
      interrupted: interrupted?.code,
    });
    return settlePostings(ctx.budget, postings, interrupted);
  }

  return {
    id: STEPSTONE_CHANNEL_ID,
    family: "stepstone",
    kind: "guest",
    usesQueries: true,
    supportsCompanyQueries: true,
    // the ghost job check: StepStone ids are stable and the detail page's full text is stored
    stableExternalIds: true,
    fullDescription: true,
    collect,
    parse: parseStepstonePayload,
  };
}

export const stepstoneChannel: Channel = createStepstoneChannel();

import { arbeitsagenturSettingsSchema, type ArbeitsagenturSettings } from "@/lib/config";

import { detailLayoutError } from "../details";
import { ChannelError, settlePostings } from "../errors";
import { loadKnownDetails, storedDetailOf } from "../known";
import { searchKind } from "../query";
import type { Channel, ChannelContext, RawPostingInput, SearchQuery } from "../types";
import { fetchDetail, fetchSearchPage } from "./client";
import { JOB_PAGE_URL, parseArbeitsagenturPayload, toDate } from "./parse";
import { redactContacts } from "./redact";
import { payloadSchema, type BaDetail, type BaPayload, type BaSearchItem } from "./schema";

export const ARBEITSAGENTUR_CHANNEL_ID = "arbeitsagentur";

function settingsOf(ctx: ChannelContext): ArbeitsagenturSettings {
  const parsed = arbeitsagenturSettingsSchema.safeParse(ctx.settings.extra);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(root)");
    throw new ChannelError("unknown", `sources.yaml sources.arbeitsagentur is not usable (${paths.join(", ")})`, { retryable: false });
  }
  return parsed.data;
}

/** Postings of the query's keywords merged without duplicates, taking one from each keyword in turn until `limit`. */
export function interleave<T extends { referenznummer: string }>(lists: readonly (readonly T[])[], limit: number): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (let i = 0; out.length < limit; i += 1) {
    let any = false;
    for (const list of lists) {
      const item = list[i];
      if (item === undefined) continue;
      any = true;
      if (seen.has(item.referenznummer)) continue;
      seen.add(item.referenznummer);
      out.push(item);
      if (out.length >= limit) break;
    }
    if (!any) break;
  }
  return out;
}

/** The detail with contact data removed from the description text (the one place free text lives). */
function redactedDetail(detail: BaDetail): BaDetail {
  return typeof detail.stellenangebotsBeschreibung === "string"
    ? { ...detail, stellenangebotsBeschreibung: redactContacts(detail.stellenangebotsBeschreibung) }
    : detail;
}

async function collect(query: SearchQuery, ctx: ChannelContext): Promise<RawPostingInput[]> {
  const settings = settingsOf(ctx);
  // Remote queries have no city: the API has no remote filter, so search all of Germany (without
  // `wo`, which also keeps postings that name no location) and keep what offers home office.
  const kind = searchKind(query);
  const remote = kind === "remote";
  const filterRemote = remote && settings.remote_requires_home_office;
  const location = kind === "city" ? query.location : null;
  // when filtering, most of a page is dropped: read full pages instead of only what is still missing
  const size = filterRemote ? settings.page_size : Math.min(settings.page_size, query.maxResults);
  const maxPages = filterRemote ? settings.remote_max_pages : Number.POSITIVE_INFINITY;
  let first = true;
  const pace = async (): Promise<void> => {
    if (!first) await ctx.throttle();
    first = false;
  };

  // ---- search: one request series per keyword. A failing page ends the search; what earlier pages
  // (and keywords) returned is kept and handed on with the failure (see the end)
  const perTerm: BaSearchItem[][] = [];
  let interrupted: ChannelError | null = null;
  search: for (const term of query.keywords) {
    const items: BaSearchItem[] = [];
    perTerm.push(items);
    for (let page = 1; items.length < query.maxResults && page <= maxPages; page += 1) {
      await pace();
      let response;
      try {
        response = await fetchSearchPage(ctx, settings, { term, kind, location, windowHours: query.windowHours, page, size });
      } catch (error) {
        if (!(error instanceof ChannelError)) throw error;
        interrupted = error;
        break search;
      }
      items.push(...(filterRemote ? response.ergebnisliste.filter((item) => item.homeofficemoeglich === true) : response.ergebnisliste));
      if (response.ergebnisliste.length === 0 || page * size >= response.maxErgebnisse) break;
    }
  }
  const selected = interleave(perTerm, query.maxResults);
  if (interrupted && selected.length === 0) throw interrupted;

  // ---- details: the job description lives only there
  const details = new Map<string, BaDetail>();
  let attempted = 0;
  let parseFailures = 0;
  let reused = 0;
  let employerSkipped = 0;
  if (settings.fetch_details) {
    // postings already stored keep their stored detail; only the others cost a request
    // an interrupted query never overwrites a stored detail with none, whatever reuse_known_details says
    const reuse = settings.reuse_known_details || interrupted !== null;
    const detailOf = storedDetailOf<BaDetail>(payloadSchema);
    const known = await loadKnownDetails(ctx, { enabled: reuse, externalIds: selected.map((item) => item.referenznummer), detailOf });
    for (const [id, detail] of known) details.set(id, detail);
    reused = known.size;
    // after a failure no further request goes out: the stored details are kept, the rest stays list data
    // company queries: another employer's detail would be dropped afterwards, so it costs no request (it stays list data)
    const unknown = selected.filter((i) => !known.has(i.referenznummer));
    const ofEmployer = unknown.filter((i) => ctx.employerMatches?.(i.firma) ?? true);
    employerSkipped = unknown.length - ofEmployer.length;
    const toFetch = interrupted ? [] : ofEmployer.slice(0, settings.max_details_per_query);
    for (const item of toFetch) {
      await pace();
      attempted += 1;
      try {
        const detail = await fetchDetail(ctx, settings, item.referenznummer);
        if (detail) details.set(item.referenznummer, redactedDetail(detail));
      } catch (error) {
        if (!(error instanceof ChannelError)) throw error;
        // an odd record only costs its own description
        if (error.code === "parse") {
          parseFailures += 1;
          ctx.logger.warn("job detail not readable, continuing with list data", { query: query.id, code: error.code });
          continue;
        }
        // a flaky API only costs the descriptions; a throttled or blocked one also ends the query, and the
        // framework backs off. Either way the list results read so far are kept (handed on with the failure below)
        ctx.logger.warn("job details unavailable, continuing with list data", { query: query.id, code: error.code, status: error.status });
        if (error.code !== "network") interrupted = error;
        break;
      }
    }
    // every detail unreadable: the API changed. The list results are still handed on, with that failure
    interrupted ??= detailLayoutError(ctx.logger, "arbeitsagentur", query.id, { attempted, parseFailures, maxPerQuery: settings.max_details_per_query });
    if (interrupted && !reuse) {
      const missing = selected.filter((i) => !details.has(i.referenznummer)).map((i) => i.referenznummer);
      for (const [id, detail] of await loadKnownDetails(ctx, { enabled: true, externalIds: missing, detailOf })) details.set(id, detail);
    }
  }

  const postings = selected.map((item): RawPostingInput => {
    const payload: BaPayload = { list: item, detail: details.get(item.referenznummer) ?? null };
    return {
      externalId: item.referenznummer,
      url: `${JOB_PAGE_URL}/${encodeURIComponent(item.referenznummer)}`,
      payload,
      postedAt: toDate(item.datumErsteVeroeffentlichung) ?? toDate(item.veroeffentlichungszeitraum?.von),
    };
  });
  ctx.logger.info("arbeitsagentur query done", { query: query.id, postings: postings.length, details: details.size, reusedDetails: reused, ...(employerSkipped > 0 ? { otherEmployerDetailsSkipped: employerSkipped } : {}), interrupted: interrupted?.code });
  return settlePostings(ctx.budget, postings, interrupted);
}

export const arbeitsagenturChannel: Channel = {
  id: ARBEITSAGENTUR_CHANNEL_ID,
  family: "arbeitsagentur",
  kind: "api",
  usesQueries: true,
  supportsCompanyQueries: true,
  // the ghost job check: the Referenznummer is stable and the detail's full text is stored
  stableExternalIds: true,
  fullDescription: true,
  collect,
  parse: parseArbeitsagenturPayload,
};

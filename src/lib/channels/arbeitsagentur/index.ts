import { arbeitsagenturSettingsSchema, type ArbeitsagenturSettings } from "@/lib/config";

import { ChannelError } from "../errors";
import { loadKnownDetails, storedDetailOf } from "../known";
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
  const remote = query.remote || query.location === null;
  const filterRemote = remote && settings.remote_requires_home_office;
  const location = remote ? null : query.location;
  // when filtering, most of a page is dropped: read full pages instead of only what is still missing
  const size = filterRemote ? settings.page_size : Math.min(settings.page_size, query.maxResults);
  const maxPages = filterRemote ? settings.remote_max_pages : Number.POSITIVE_INFINITY;
  let first = true;
  const pace = async (): Promise<void> => {
    if (!first) await ctx.throttle();
    first = false;
  };

  // ---- search: one request series per keyword
  const perTerm: BaSearchItem[][] = [];
  for (const term of query.keywords) {
    const items: BaSearchItem[] = [];
    for (let page = 1; items.length < query.maxResults && page <= maxPages; page += 1) {
      await pace();
      const response = await fetchSearchPage(ctx, settings, { term, location, windowHours: query.windowHours, page, size });
      items.push(...(filterRemote ? response.ergebnisliste.filter((item) => item.homeofficemoeglich === true) : response.ergebnisliste));
      if (response.ergebnisliste.length === 0 || page * size >= response.maxErgebnisse) break;
    }
    perTerm.push(items);
  }
  const selected = interleave(perTerm, query.maxResults);

  // ---- details: the job description lives only there
  const details = new Map<string, BaDetail>();
  let reused = 0;
  if (settings.fetch_details) {
    // postings already stored keep their stored detail; only the others cost a request
    const known = await loadKnownDetails(ctx, {
      enabled: settings.reuse_known_details,
      externalIds: selected.map((item) => item.referenznummer),
      detailOf: storedDetailOf<BaDetail>(payloadSchema),
    });
    for (const [id, detail] of known) details.set(id, detail);
    reused = known.size;
    for (const item of selected.filter((i) => !known.has(i.referenznummer)).slice(0, settings.max_details_per_query)) {
      await pace();
      try {
        const detail = await fetchDetail(ctx, settings, item.referenznummer);
        if (detail) details.set(item.referenznummer, redactedDetail(detail));
      } catch (error) {
        // a throttled or blocked API ends the query (the framework backs off); a flaky one only costs the descriptions
        if (!(error instanceof ChannelError) || error.code !== "network") throw error;
        ctx.logger.warn("job details unavailable, continuing with list data", { query: query.id, code: error.code, status: error.status });
        break;
      }
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
  ctx.logger.info("arbeitsagentur query done", { query: query.id, postings: postings.length, details: details.size, reusedDetails: reused });
  await ctx.budget.consume(postings.length);
  return postings;
}

export const arbeitsagenturChannel: Channel = {
  id: ARBEITSAGENTUR_CHANNEL_ID,
  family: "arbeitsagentur",
  kind: "api",
  usesQueries: true,
  collect,
  parse: parseArbeitsagenturPayload,
};

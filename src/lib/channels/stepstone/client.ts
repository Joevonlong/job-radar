import type { z } from "zod";

import type { StepstoneSettings } from "@/lib/config";

import { ChannelError } from "../errors";
import type { ChannelContext } from "../types";
import { htmlToText } from "../ats/text";
import { redactJobText } from "../web/redact";
import { extractJsonAfter, extractJsonLdBlocks, findJobPosting } from "../web/embedded";
import { fetchHtml, missingDataError } from "../web/page";
import { slugify } from "../web/select";
import {
  jobAdContentSchema,
  listItemSchema,
  searchStateSchema,
  type StepstoneDetail,
  type StepstoneListItem,
} from "./schema";

type ClientSettings = Pick<StepstoneSettings, "base_url" | "user_agent">;

/**
 * StepStone's robots.txt (`User-agent: *`) disallows `/jobs/*?*` and re-allows `/jobs/*?q=*`, but disallows `/jobs/*?q*&*` again:
 * the only query form a search URL may carry is a single `q=` parameter. Everything else (`sort`, `ag`, `radius`, `wfh`, `page`) is
 * out, so the channel has no time sort, no look-back or radius filter and no paging: one request per keyword and place, answered
 * in StepStone's own order, and the look-back window is applied afterwards from each result's posting date.
 */
const PERMITTED_SEARCH_URL = /^[^?#]*\?q=[A-Za-z0-9%-]+$/;
/** A longer slug (for example seven keywords joined by "-or-") is answered with 403 "Access denied". */
export const MAX_SLUG_LENGTH = 100;
/** Sections of a result list that answer the search; `recommended` and `regional` are filler. */
export const ANSWER_SECTIONS: ReadonlySet<string> = new Set(["main", "semantic"]);
/** `workFromHome` values of a posting that allows home office ("1" home office only, "2" home office possible; "0" not stated). */
export const HOME_OFFICE_VALUES: ReadonlySet<string> = new Set(["1", "2"]);
const STATE_ANCHOR = 'window.__PRELOADED_STATE__["app-unifiedResultlist"]';
const JOB_AD_ANCHOR = /window\.__PRELOADED_STATE__\.JobAdContent\s*=\s*\{\s*props:/;

export interface SearchParams {
  keyword: string;
  /** City, or null for the nationwide home-office search. */
  location: string | null;
  /** `company`: the keyword is an employer name searched nationwide, with no city. */
  kind?: "city" | "remote" | "company";
}

/**
 * Search URL of one keyword (one request per keyword: OR-ed keywords drift into loose matches): `/jobs/<keyword>[/in-<city>]?q=<keyword>`.
 * Null when the keyword has no usable slug, or when the URL would not be one robots.txt permits.
 */
export function searchUrl(settings: ClientSettings, params: SearchParams): string | null {
  const slug = slugify(params.keyword);
  if (slug === "" || slug.length > MAX_SLUG_LENGTH) return null;
  const nationwide = params.kind === "company";
  const where = params.location === null || nationwide ? "" : `/in-${encodeURIComponent(slugify(params.location))}`;
  const url = `${settings.base_url.replace(/\/+$/, "")}/jobs/${encodeURIComponent(slug)}${where}?q=${encodeURIComponent(slug)}`;
  return PERMITTED_SEARCH_URL.test(url) ? url : null;
}

export interface SearchPage {
  /** Valid results of every section, in the order of the page. */
  items: StepstoneListItem[];
  /** Total pages for the search, when the page says. */
  pageCount: number | null;
  /** Results that did not match the expected shape. */
  rejected: number;
}

/** One page of search results. A page without search state is a block page or a layout change. */
export async function fetchSearchPage(ctx: ChannelContext, settings: ClientSettings, url: string): Promise<SearchPage> {
  const host = new URL(url).host;
  const html = await fetchHtml(ctx, { url, userAgent: settings.user_agent });
  if (html === null) throw new ChannelError("unknown", `${host}: search page not found`, { retryable: false, status: 404 });
  const raw = extractJsonAfter(html, STATE_ANCHOR, "StepStone search state");
  if (raw === null) throw missingDataError(html, host, "the search state");
  const state = searchStateSchema.safeParse(raw);
  if (!state.success) throw new ChannelError("parse", `${host}: search state does not match the expected shape`);
  const { items: rawItems, pagination, unifiedPagination } = state.data.searchResults;
  const items: StepstoneListItem[] = [];
  let rejected = 0;
  for (const raw of rawItems) {
    const item = listItemSchema.safeParse(raw);
    if (item.success) items.push(item.data);
    else rejected += 1;
  }
  if (rawItems.length > 0 && items.length === 0) throw new ChannelError("parse", `${host}: no search result matches the expected shape`);
  return { items, pageCount: unifiedPagination?.pageCount ?? pagination?.pageCount ?? null, rejected };
}

/** Absolute posting URL without the tracking query, or null when it would leave the configured site. */
export function postingUrl(settings: ClientSettings, item: StepstoneListItem): string | null {
  let url: URL;
  try {
    url = new URL(item.url, settings.base_url);
  } catch {
    return null;
  }
  if (url.origin !== new URL(settings.base_url).origin) return null;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function plainText(html: string): string {
  return redactJobText(htmlToText(html));
}

/**
 * The parts of a posting page the channel keeps, or null when the posting is gone. Throws `blocked` /
 * `parse` for pages that carry no posting data at all.
 */
export async function fetchDetail(ctx: ChannelContext, settings: ClientSettings, url: string): Promise<StepstoneDetail | null> {
  const html = await fetchHtml(ctx, { url, userAgent: settings.user_agent });
  if (html === null) return null;
  const host = new URL(url).host;
  const jsonLd = findJobPosting(extractJsonLdBlocks(html));
  const rawAd = extractJsonAfter(html, JOB_AD_ANCHOR, "StepStone job ad");
  if (jsonLd === null && rawAd === null) throw missingDataError(html, host, "the job posting data");

  let ad: z.infer<typeof jobAdContentSchema> | null = null;
  if (rawAd !== null) {
    const parsed = jobAdContentSchema.safeParse(rawAd);
    if (!parsed.success) throw new ChannelError("parse", `${host}: job ad data does not match the expected shape`);
    ad = parsed.data;
  }
  const header = ad?.listingHeader;

  // the JSON-LD description is the preferred text; the page sections only fill in when it is missing
  const description = typeof jsonLd?.description === "string" ? jsonLd.description : null;
  const sections =
    description === null && ad?.textSections
      ? ad.textSections.flatMap((s) => (s.content ? [{ title: s.title ?? null, text: plainText(s.content) }] : []))
      : null;

  return {
    jsonLd: jsonLd === null ? null : { ...jsonLd, ...(description === null ? {} : { description: plainText(description) }) },
    jobAd:
      ad === null
        ? null
        : {
            metaData: header?.listingData?.metaData ?? null,
            salary: header?.CESalary ?? null,
            language: ad.offerLanguage ?? header?.language ?? null,
            sections,
          },
  };
}

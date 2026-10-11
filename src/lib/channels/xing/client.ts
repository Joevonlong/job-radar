import type { z } from "zod";

import type { XingSettings } from "@/lib/config";

import { ChannelError } from "../errors";
import type { ChannelContext } from "../types";
import { htmlToText } from "../ats/text";
import { redactJobText } from "../web/redact";
import { extractJsonAfter, extractJsonLdBlocks, findJobPosting } from "../web/embedded";
import { fetchHtml, missingDataError } from "../web/page";
import {
  apolloStateSchema,
  jobSchema,
  listItemSchema,
  searchResultSchema,
  type XingDetail,
  type XingListItem,
} from "./schema";

type ClientSettings = Pick<XingSettings, "base_url" | "user_agent" | "radius_km" | "remote_option_id">;

/** Path of the search page (`/jobs/search` redirects here). */
const SEARCH_PATH = "/jobs/search/ki";
const APOLLO_ANCHOR = '"APOLLO_STATE":';
const SEARCH_KEY = "jobSearchByQuery(";
const JOB_KEY = "job(";
/** Results per search page (the `limit` of XING's own query). */
export const PAGE_SIZE = 20;

type ApolloState = z.infer<typeof apolloStateSchema>;

export interface SearchParams {
  keyword: string;
  /** City, or null for the nationwide fully-remote search. */
  location: string | null;
  /** 1-based. */
  page: number;
}

export function searchUrl(settings: ClientSettings, params: SearchParams): string {
  const query = new URLSearchParams({ keywords: params.keyword });
  if (params.location === null) query.set("remoteOption", settings.remote_option_id);
  else {
    query.set("location", params.location);
    query.set("radius", String(settings.radius_km));
  }
  if (params.page > 1) query.set("page", String(params.page));
  return `${settings.base_url.replace(/\/+$/, "")}${SEARCH_PATH}?${query.toString()}`;
}

function readState(html: string, host: string): ApolloState {
  const raw = extractJsonAfter(html, APOLLO_ANCHOR, "XING page data");
  if (raw === null) throw missingDataError(html, host, "the page data");
  const state = apolloStateSchema.safeParse(raw);
  if (!state.success) throw new ChannelError("parse", `${host}: page data does not match the expected shape`);
  return state.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The entity a `{ __ref }` points at, or the value itself when it is not a reference. */
function deref(state: ApolloState, value: unknown): unknown {
  if (isRecord(value) && typeof value.__ref === "string") return state[value.__ref] ?? null;
  return value;
}

/** Fields that describe the viewer, not the posting, or that the JSON-LD already carries (the description template also holds the contact block). */
const VIEWER_FIELDS = ["userInteractions", "userProfileMatches", "description"] as const;
const LOOKUP_FIELDS = ["employmentType", "careerLevel", "discipline", "industry"] as const;

/** A job entity with its small lookups (`employmentType`, `careerLevel`, ...) written out and viewer-specific fields removed. */
function resolveJob(state: ApolloState, entity: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...entity };
  for (const key of VIEWER_FIELDS) delete out[key];
  for (const key of LOOKUP_FIELDS) {
    if (key in out) out[key] = deref(state, out[key]);
  }
  return out;
}

export interface SearchPage {
  items: XingListItem[];
  /** Results of the whole search, when the page says (capped at 1000 by XING). */
  total: number | null;
  rejected: number;
}

/** One page of search results. A page without page data is a block page or a layout change. */
export async function fetchSearchPage(ctx: ChannelContext, settings: ClientSettings, url: string): Promise<SearchPage> {
  const host = new URL(url).host;
  const html = await fetchHtml(ctx, { url, userAgent: settings.user_agent });
  if (html === null) throw new ChannelError("unknown", `${host}: search page not found`, { retryable: false, status: 404 });
  const state = readState(html, host);
  const root = state.ROOT_QUERY;
  const key = isRecord(root) ? Object.keys(root).find((k) => k.startsWith(SEARCH_KEY)) : undefined;
  const result = key !== undefined && isRecord(root) ? searchResultSchema.safeParse(root[key]) : null;
  if (result === null || !result.success) {
    throw new ChannelError("parse", `${host}: the page has no search result (is remote_option_id still valid? did the layout change?)`);
  }
  const items: XingListItem[] = [];
  let rejected = 0;
  for (const entry of result.data.collection) {
    const entity = deref(state, entry.jobDetail);
    const item = isRecord(entity) ? listItemSchema.safeParse(resolveJob(state, entity)) : null;
    if (item?.success) items.push(item.data);
    else rejected += 1;
  }
  if (result.data.collection.length > 0 && items.length === 0) throw new ChannelError("parse", `${host}: no search result matches the expected shape`);
  const total = result.data.boundedTotal?.total;
  return { items, total: total !== undefined && total !== null && total >= 0 ? total : null, rejected };
}

/** Numeric posting id (`157369813` of `157369813.d962f0`). */
export function postingId(item: Pick<XingListItem, "id">): string {
  return item.id.split(".")[0] ?? item.id;
}

/** Absolute posting URL, or null when it would leave the configured site. */
export function postingUrl(settings: ClientSettings, item: Pick<XingListItem, "slug">): string | null {
  const base = new URL(settings.base_url);
  const url = new URL(`/jobs/${encodeURIComponent(item.slug)}`, base);
  return url.origin === base.origin ? url.toString() : null;
}

function plainText(html: string): string {
  return redactJobText(htmlToText(html));
}

interface DescriptionTemplate {
  title: unknown;
  content: unknown;
}

/** Sections of the posting page's description template, as text. */
function templateSections(template: unknown): Array<{ title: string | null; text: string }> {
  if (!isRecord(template)) return [];
  const pairs: DescriptionTemplate[] = [
    { title: template.companyDescriptionTitle, content: template.companyDescriptionContent },
    { title: template.responsibilityTitle, content: template.responsibilityContent },
    { title: template.skillsTitle, content: template.skillsContent },
    { title: template.weOfferTitle, content: template.weOfferContent },
    { title: null, content: template.genericDescription },
  ];
  return pairs.flatMap(({ title, content }) =>
    typeof content === "string" && content.trim() !== "" ? [{ title: typeof title === "string" ? title : null, text: plainText(content) }] : [],
  );
}

/**
 * The parts of a posting page the channel keeps, or null when the posting is gone. Throws `blocked` /
 * `parse` for pages that carry no posting data at all.
 */
export async function fetchDetail(ctx: ChannelContext, settings: ClientSettings, url: string): Promise<XingDetail | null> {
  const html = await fetchHtml(ctx, { url, userAgent: settings.user_agent });
  if (html === null) return null;
  const host = new URL(url).host;
  const state = readState(html, host);
  const jsonLd = findJobPosting(extractJsonLdBlocks(html));
  const root = state.ROOT_QUERY;
  const key = isRecord(root) ? Object.keys(root).find((k) => k.startsWith(JOB_KEY)) : undefined;
  const entity = key !== undefined && isRecord(root) ? deref(state, root[key]) : null;
  if (jsonLd === null && !isRecord(entity)) throw missingDataError(html, host, "the job posting data");

  let job: XingDetail["job"] = null;
  let sections: XingDetail["sections"] = null;
  if (isRecord(entity)) {
    const parsed = jobSchema.safeParse(resolveJob(state, entity));
    if (!parsed.success) throw new ChannelError("parse", `${host}: job data does not match the expected shape`);
    job = parsed.data;
    const hasLdText = typeof jsonLd?.description === "string" && jsonLd.description.trim() !== "";
    if (!hasLdText) sections = templateSections(entity.description);
  }
  return {
    jsonLd: jsonLd === null ? null : { ...jsonLd, ...(typeof jsonLd.description === "string" ? { description: plainText(jsonLd.description) } : {}) },
    job,
    sections,
  };
}

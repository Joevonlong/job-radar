import { z } from "zod";

import { ChannelError, isAbortError } from "@/lib/channels/errors";
import { marketForChannel } from "@/lib/channels/market";
import type { ChannelContext, NormalizedPostingDraft } from "@/lib/channels/types";
import type { CompanyEntry } from "@/lib/config";
import { smartrecruitersChannelSchema } from "@/lib/config";

import type { AtsAdapter, ListedPosting } from "./collect";
import { conditionalHeaders, type BoardFetch } from "./conditional";
import { htmlFragments, issuePaths, readEnvelopePosting, unwrapPayload } from "./envelope";
import { htmlToText } from "./text";

/**
 * SmartRecruiters public posting API. `GET /v1/companies/{id}/postings?limit&offset&country` lists
 * the postings (paged, no description); `GET /v1/companies/{id}/postings/{postingId}` has the ad
 * text. The first page carries the ETag and `totalFound`, which changes whenever a posting opens or
 * closes, so a 304 on the first page means the whole board is unchanged. An unknown company id is
 * not a 404: the API answers with an empty list. Detail failures keep the board healthy: stored
 * postings stay seen with their old payload, and retry state controls request order and whether
 * the list validator can be reused. Consecutive failures or a host refusal stop remaining details.
 */

type Settings = z.infer<typeof smartrecruitersChannelSchema>;

const listPageSchema = z.looseObject({
  totalFound: z.number().int().nonnegative(),
  content: z.array(z.unknown()),
});

const listSchema = z.looseObject({ content: z.array(z.unknown()) });

const labelled = z.looseObject({ label: z.string().nullable().optional() }).nullable().optional();
const section = z.looseObject({ title: z.string().nullable().optional(), text: z.string().nullable().optional() }).nullable().optional();

const postingSchema = z.looseObject({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  refNumber: z.string().nullable().optional(),
  company: z.looseObject({ identifier: z.string().nullable().optional(), name: z.string().nullable().optional() }).nullable().optional(),
  releasedDate: z.string().nullable().optional(),
  location: z
    .looseObject({
      city: z.string().nullable().optional(),
      region: z.string().nullable().optional(),
      country: z.string().nullable().optional(),
      fullLocation: z.string().nullable().optional(),
      remote: z.boolean().nullable().optional(),
      hybrid: z.boolean().nullable().optional(),
    })
    .nullable()
    .optional(),
  department: labelled,
  function: labelled,
  industry: labelled,
  typeOfEmployment: labelled,
  experienceLevel: labelled,
  language: z.looseObject({ code: z.string().nullable().optional() }).nullable().optional(),
  postingUrl: z.string().nullable().optional(),
  applyUrl: z.string().nullable().optional(),
  jobAd: z
    .looseObject({
      sections: z
        .looseObject({
          companyDescription: section,
          jobDescription: section,
          qualifications: section,
          additionalInformation: section,
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});
type SmartRecruitersPosting = z.infer<typeof postingSchema>;

const httpUrl = z.url({ protocol: /^https?$/ });

function urlOrNull(value: string | null | undefined): string | null {
  const parsed = httpUrl.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function dateOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}

function companyBase(company: CompanyEntry, settings: Settings): string {
  return `${settings.api_base_url.replace(/\/+$/, "")}/v1/companies/${encodeURIComponent(company.token)}/postings`;
}

function pageUrl(company: CompanyEntry, settings: Settings, offset: number): string {
  const params = new URLSearchParams({ limit: String(settings.page_size), offset: String(offset) });
  // A missing country follows the market; an empty one means every country
  const country = settings.country ?? marketForChannel().country.toLowerCase();
  if (country !== "") params.set("country", country);
  return `${companyBase(company, settings)}?${params.toString()}`;
}

async function fetchJson(ctx: ChannelContext, url: string, etag: string | null): Promise<{ status: number; etag: string | null; body: unknown }> {
  const response = await ctx.http.request(url, { headers: conditionalHeaders(etag), allowStatus: [304, 404] });
  if (response.status === 304 || response.status === 404) return { status: response.status, etag: null, body: null };
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new ChannelError("parse", `response from ${new URL(url).host} is not valid JSON`, { cause: error });
  }
  const header = response.headers.get("etag");
  return { status: response.status, etag: header !== null && header.trim() !== "" ? header : null, body };
}

function shapeError(error: z.ZodError): ChannelError {
  return new ChannelError("parse", `smartrecruiters board response does not match the expected shape (${issuePaths(error)})`);
}

/** Every page of the list, newest first. Only the first request is conditional. */
async function fetchBoard(ctx: ChannelContext, company: CompanyEntry, settings: Settings, etag: string | null): Promise<BoardFetch> {
  const first = await fetchJson(ctx, pageUrl(company, settings, 0), etag);
  if (first.status === 404) return { kind: "not_found" };
  if (first.status === 304) {
    if (etag === null) throw new ChannelError("unknown", "HTTP 304 without a conditional request", { status: 304 });
    return { kind: "not_modified" };
  }
  const head = listPageSchema.safeParse(first.body);
  if (!head.success) throw shapeError(head.error);
  const content = [...head.data.content];
  const total = head.data.totalFound;
  let lastPage = head.data.content.length;
  while (lastPage > 0 && content.length < total) {
    ctx.signal.throwIfAborted();
    await ctx.throttle();
    const next = await fetchJson(ctx, pageUrl(company, settings, content.length), null);
    if (next.status === 404) break;
    const page = listSchema.safeParse(next.body);
    if (!page.success) throw shapeError(page.error);
    lastPage = page.data.content.length;
    content.push(...page.data.content);
  }
  return { kind: "content", body: { totalFound: total, content }, etag: first.etag, complete: content.length >= total };
}

async function enrich(ctx: ChannelContext, posting: unknown, company: CompanyEntry, settings: Settings): Promise<unknown> {
  const id = (posting as { id?: unknown }).id;
  if (typeof id !== "string") return posting;
  const response = await ctx.http.request(`${companyBase(company, settings)}/${encodeURIComponent(id)}`, {
    headers: conditionalHeaders(null),
    allowStatus: [404],
  });
  // closed between the list and the detail
  if (response.status === 404) return null;
  try {
    return await response.json();
  } catch (error) {
    // Body-stream failures keep their channel code, and cancellation must still propagate.
    if (error instanceof ChannelError || isAbortError(error) || ctx.signal.aborted) throw error;
    throw new ChannelError("parse", `smartrecruiters posting detail is not valid JSON`, { cause: error });
  }
}

function describe(posting: unknown): ListedPosting | null {
  if (typeof posting !== "object" || posting === null) return null;
  const record = posting as Record<string, unknown>;
  const externalId = typeof record.id === "string" ? record.id.trim() : "";
  if (externalId === "") return null;
  const identifier = (record.company as { identifier?: unknown } | null | undefined)?.identifier;
  return {
    externalId,
    title: typeof record.name === "string" ? record.name : null,
    url: typeof identifier === "string" && identifier !== "" ? `https://jobs.smartrecruiters.com/${encodeURIComponent(identifier)}/${encodeURIComponent(externalId)}` : null,
    postedAt: dateOrNull(typeof record.releasedDate === "string" ? record.releasedDate : null),
  };
}

export const smartrecruitersAdapter: AtsAdapter<Settings> = {
  id: "smartrecruiters",
  settingsSchema: smartrecruitersChannelSchema,
  boardUrl: (company, settings) => pageUrl(company, settings, 0),
  fetchBoard,
  list(body) {
    const parsed = listSchema.safeParse(body);
    if (!parsed.success) throw shapeError(parsed.error);
    return parsed.data.content;
  },
  describe,
  details: {
    enabled: (settings) => settings.fetch_details,
    enrich,
    maxConsecutiveFailures: (settings) => settings.max_consecutive_detail_failures,
  },
  parse(payload) {
    const { source, posting } = unwrapPayload(payload, "smartrecruiters");
    const parsed = postingSchema.safeParse(posting);
    if (!parsed.success) {
      throw new ChannelError("parse", `smartrecruiters posting does not match the expected shape (${issuePaths(parsed.error)})`);
    }
    return toDraft(parsed.data, source.companyName);
  },
  descriptionHtml(payload) {
    const posting = readEnvelopePosting(payload, "smartrecruiters", postingSchema);
    const sections = posting?.jobAd?.sections;
    if (!sections) return [];
    return htmlFragments(
      (["jobDescription", "qualifications", "additionalInformation", "companyDescription"] as const).map((key) => ({ path: `posting.jobAd.sections.${key}.text`, html: sections[key]?.text })),
    );
  },
};

function descriptionOf(posting: SmartRecruitersPosting): string {
  const sections = posting.jobAd?.sections;
  // the role first, the company boilerplate last
  const ordered = [sections?.jobDescription, sections?.qualifications, sections?.additionalInformation, sections?.companyDescription];
  return ordered
    .map((entry) => {
      const heading = entry?.title?.trim() ?? "";
      const body = htmlToText(entry?.text ?? "");
      return body === "" ? "" : [heading, body].filter((p) => p !== "").join("\n");
    })
    .filter((block) => block !== "")
    .join("\n\n");
}

function workplaceOf(posting: SmartRecruitersPosting): NormalizedPostingDraft["workplace"] {
  if (posting.location?.remote === true) return "remote";
  if (posting.location?.hybrid === true) return "hybrid";
  return "unknown";
}

function toDraft(posting: SmartRecruitersPosting, companyName: string): NormalizedPostingDraft {
  const location = posting.location;
  const city = location?.city?.trim() || null;
  const country = location?.country?.trim().toUpperCase() ?? "";
  const label = location?.fullLocation?.replace(/(,\s*)+/g, ", ").trim() || [city, location?.country?.toUpperCase()].filter((p) => p).join(", ");
  const language = posting.language?.code?.trim().toLowerCase();
  const level = posting.experienceLevel?.label?.trim() ?? "";
  const url = urlOrNull(posting.postingUrl);
  return {
    title: posting.name,
    companyName,
    locations: label ? [{ label, city, countryCode: /^[A-Z]{2}$/.test(country) ? country : null }] : [],
    workplace: workplaceOf(posting),
    contractHint: posting.typeOfEmployment?.label?.trim() || null,
    seniorityHint: level !== "" && !/^not applicable$/i.test(level) ? level : null,
    salaryText: null,
    salary: null,
    description: descriptionOf(posting),
    ...(language && /^[a-z]{2}$/.test(language) ? { descriptionLanguage: language } : {}),
    postedAt: dateOrNull(posting.releasedDate),
    applyUrl: urlOrNull(posting.applyUrl) ?? url,
    sourceUrl: url,
    extra: {
      ats: "smartrecruiters",
      refNumber: posting.refNumber ?? null,
      department: posting.department?.label ?? null,
      function: posting.function?.label ?? null,
      industry: posting.industry?.label ?? null,
      region: location?.region ?? null,
    },
  };
}

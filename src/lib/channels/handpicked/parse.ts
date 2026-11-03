import { htmlFragments, issuePaths } from "../ats/envelope";
import { htmlToText } from "../ats/text";
import { ChannelError } from "../errors";
import type { DescriptionHtmlFragment, NormalizedPostingDraft } from "../types";
import { redactJobText } from "../web/redact";
import { storedPayloadSchema, type HandpickedStoredPayload } from "./schema";

/** The site's own separator between the places of one posting. */
const LOCATION_SEPARATOR = " · ";

function clean(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  return text ? text : undefined;
}

function httpUrlOrNull(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** `YYYY-MM-DD` -> that day at 00:00 UTC; null for anything that is not a real calendar date. */
export function fromDateOnly(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function readPayload(payload: unknown): HandpickedStoredPayload {
  const parsed = storedPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new ChannelError("parse", `handpicked payload does not match the expected shape (${issuePaths(parsed.error)})`);
  return parsed.data;
}

function workplaceOf(remoteType: string): NormalizedPostingDraft["workplace"] {
  // `onsite` is 78% of the index and looks like the site's default: it is no evidence of an on-site job (C3)
  if (remoteType === "remote") return "remote";
  if (remoteType === "hybrid") return "hybrid";
  return "unknown";
}

/**
 * A stored posting (`{ index, detail }` as delivered) -> the normalized draft. Contract, seniority and salary are not
 * stated (the salary range text is passed on for the pipeline to read). The description is the detail HTML as text without
 * e-mail addresses and phone numbers; the stored payload keeps them (C1). The apply and source link is the employer's own
 * posting URL: the site has no posting pages of its own.
 */
export function parseHandpickedPayload(payload: unknown): NormalizedPostingDraft {
  const { index, detail } = readPayload(payload);
  const title = clean(index.title);
  if (!title) throw new ChannelError("parse", "handpicked posting has no title");
  const companyName = clean(index.company);
  if (!companyName) throw new ChannelError("parse", "handpicked posting has no company name");

  const locations = index.location
    .split(LOCATION_SEPARATOR)
    .map((part) => clean(part))
    .filter((part): part is string => part !== undefined)
    .map((label) => ({ label, city: null, countryCode: null }));
  const link = httpUrlOrNull(detail.url) ?? httpUrlOrNull(index.url);

  return {
    title,
    companyName,
    locations,
    workplace: workplaceOf(index.remoteType),
    contractHint: null,
    seniorityHint: null,
    salaryText: clean(index.salaryRange) ?? null,
    salary: null,
    description: redactJobText(htmlToText(detail.descriptionHTML)),
    postedAt: fromDateOnly(index.postedAt),
    applyUrl: link,
    sourceUrl: link,
    extra: {
      id: index.id,
      category: index.category ?? null,
      isInternship: index.isInternship ?? null,
      tier: index.tier ?? null,
      cities: index.cities,
      companyDomain: index.companyDomain ?? null,
      location: index.location,
    },
  };
}

/** The detail HTML for the trap scan; `[]` when the payload is not a Handpicked posting. */
export function handpickedDescriptionHtml(payload: unknown): DescriptionHtmlFragment[] {
  const parsed = storedPayloadSchema.safeParse(payload);
  return parsed.success ? htmlFragments([{ path: "detail.descriptionHTML", html: parsed.data.detail.descriptionHTML }]) : [];
}

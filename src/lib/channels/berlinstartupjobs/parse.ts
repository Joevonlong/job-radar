import { htmlFragments, issuePaths } from "../ats/envelope";
import { decodeHtml, htmlToText } from "../ats/text";
import { ChannelError } from "../errors";
import type { DescriptionHtmlFragment, NormalizedPostingDraft } from "../types";
import { redactJobText } from "../web/redact";
import { envelopeSchema, POST_FIELDS, type BerlinStartupJobsEnvelope, type BerlinStartupJobsTerm } from "./schema";

/** Separates the role from the company in a title ("Founding Engineer (m/f/d) // Example Robotics GmbH"). */
const TITLE_SEPARATOR = " // ";

/** Location terms of the site that say how the job is worked, not where: they are not places. `remote` is the only one that states a fact. */
export const REMOTE_SLUG = "remote";
export const REMOTE_POSSIBLE_SLUG = "remote-possible";

function clean(value: string): string {
  return decodeHtml(value).replace(/\s+/g, " ").trim();
}

/** The title split at its LAST separator (a role may contain one): the role, and the company the title ends with (null when it has no suffix). */
export function splitTitle(rendered: string): { role: string; suffix: string | null } {
  const title = clean(rendered);
  const at = title.lastIndexOf(TITLE_SEPARATOR);
  if (at < 0) return { role: title, suffix: null };
  const suffix = title.slice(at + TITLE_SEPARATOR.length).trim();
  return { role: title.slice(0, at).trim(), suffix: suffix === "" ? null : suffix };
}

/** The company of a post: the site's company term, else the end of the title. null when neither names one. */
export function companyOf(titleRendered: string, term: Pick<BerlinStartupJobsTerm, "name"> | undefined): string | null {
  const named = term ? clean(term.name) : "";
  if (named !== "") return named;
  return splitTitle(titleRendered).suffix;
}

const SITE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
const ZONED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** `date_gmt` (site time without a zone, in UTC) -> Date; null when it is not a date. */
export function fromGmt(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const date = SITE_TIME.test(text) ? new Date(`${text}Z`) : ZONED_TIME.test(text) ? new Date(text) : null;
  return date === null || Number.isNaN(date.getTime()) ? null : date;
}

/** `_unpublish_on` (`YYYY-MM-DD`) -> the start of that day in UTC; null for null, an empty string or anything that is not a real calendar date. */
export function unpublishDay(value: string | null | undefined): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((value ?? "").trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
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

/** A post as stored: only the whitelisted keys of what the server sent, in whitelist order (so equal input gives an equal payload). */
export function trimPost(raw: unknown): Record<string, unknown> {
  const source = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const key of POST_FIELDS) if (Object.hasOwn(source, key)) out[key] = source[key];
  return out;
}

function readEnvelope(payload: unknown): BerlinStartupJobsEnvelope {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success) throw new ChannelError("parse", `berlinstartupjobs payload does not match the expected shape (${issuePaths(parsed.error)})`);
  return parsed.data;
}

/**
 * A stored posting (`{ post, terms }`) -> the normalized draft. Facts the site does not state stay unknown (C3): "remote possible"
 * is not hybrid and an unmarked job is not on site; the categories and the package are the site's own grouping, not a contract or a
 * level. The title loses its " // Company" end, so the same job from another source matches. The description is the HTML as text,
 * without e-mail addresses and phone numbers; the stored payload keeps them (C1). The apply link is the site's page for the job,
 * never a `mailto:`.
 */
export function parseBerlinStartupJobsPayload(payload: unknown): NormalizedPostingDraft {
  const { post, terms } = readEnvelope(payload);
  const role = splitTitle(post.title.rendered).role;
  if (role === "") throw new ChannelError("parse", "berlinstartupjobs posting has no title");
  const companyName = companyOf(post.title.rendered, terms.job_company[0]);
  if (!companyName) throw new ChannelError("parse", "berlinstartupjobs posting has no company name");

  const remoteSlugs = terms.job_location.map((t) => t.slug).filter((slug) => slug === REMOTE_SLUG || slug === REMOTE_POSSIBLE_SLUG);
  const places = terms.job_location.filter((t) => t.slug !== REMOTE_SLUG && t.slug !== REMOTE_POSSIBLE_SLUG).map((t) => clean(t.name)).filter((name) => name !== "");
  const url = httpUrlOrNull(post.link);

  return {
    title: role,
    companyName,
    // city and country are resolved by the pipeline per market
    locations: places.map((label) => ({ label, city: null, countryCode: null })),
    workplace: remoteSlugs.includes(REMOTE_SLUG) ? "remote" : "unknown",
    contractHint: null,
    seniorityHint: null,
    salaryText: null,
    salary: null,
    description: redactJobText(htmlToText(post.content.rendered)),
    postedAt: fromGmt(post.date_gmt),
    applyUrl: url,
    sourceUrl: url,
    extra: {
      id: post.id,
      slug: post.slug ?? null,
      categories: post.categories,
      tags: post.tags,
      jobPlan: post.job_plan,
      unpublishOn: post._unpublish_on ?? null,
      featured: post._is_featured ?? null,
      remote: remoteSlugs,
    },
  };
}

/** The posting's HTML description for the trap scan; `[]` when the payload is not a stored posting. */
export function berlinStartupJobsDescriptionHtml(payload: unknown): DescriptionHtmlFragment[] {
  const parsed = envelopeSchema.safeParse(payload);
  return parsed.success ? htmlFragments([{ path: "post.content.rendered", html: parsed.data.post.content.rendered }]) : [];
}

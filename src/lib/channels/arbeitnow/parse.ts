import { htmlFragments, issuePaths } from "../ats/envelope";
import { htmlToText } from "../ats/text";
import { ChannelError } from "../errors";
import type { DescriptionHtmlFragment, NormalizedPostingDraft } from "../types";
import { redactJobText } from "../web/redact";
import { storedJobSchema, type StoredArbeitnowJob } from "./schema";

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

/** Largest Unix time in seconds with a four-digit year (9999-12-31T23:59:59Z). A millisecond value lies far above it. */
const MAX_UNIX_SECONDS = 253_402_300_799;

/** Unix seconds -> Date; null for anything that is not a finite number of seconds between 1970 and the year 9999. */
export function fromUnixSeconds(value: unknown): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_UNIX_SECONDS) return null;
  return new Date(value * 1000);
}

function readJob(payload: unknown): StoredArbeitnowJob {
  const parsed = storedJobSchema.safeParse(payload);
  if (!parsed.success) throw new ChannelError("parse", `arbeitnow payload does not match the expected shape (${issuePaths(parsed.error)})`);
  return parsed.data;
}

/**
 * A stored posting (the API object as delivered) -> the normalized draft. Facts the API does not state stay unknown (C3):
 * `remote: false` only means "not marked remote", `job_types` is free text passed on as a hint, no seniority, no salary (the
 * pipeline reads it from the text). The description is the HTML as text, without e-mail addresses and phone numbers; the
 * stored payload keeps them (C1).
 */
export function parseArbeitnowPayload(payload: unknown): NormalizedPostingDraft {
  const job = readJob(payload);
  const title = clean(job.title);
  if (!title) throw new ChannelError("parse", "arbeitnow posting has no title");
  const companyName = clean(job.company_name);
  if (!companyName) throw new ChannelError("parse", "arbeitnow posting has no company name");

  // one location as worded ("Hamburg or Berlin" stays one); city and country are resolved by the pipeline per market
  const label = clean(job.location);
  const jobTypes = job.job_types.map((t) => clean(t)).filter((t): t is string => t !== undefined);
  const url = httpUrlOrNull(job.url);

  return {
    title,
    companyName,
    locations: label ? [{ label, city: null, countryCode: null }] : [],
    workplace: job.remote === true ? "remote" : "unknown",
    contractHint: jobTypes.length > 0 ? jobTypes.join(", ") : null,
    seniorityHint: null,
    salaryText: null,
    salary: null,
    description: redactJobText(htmlToText(job.description)),
    postedAt: fromUnixSeconds(job.created_at),
    applyUrl: url,
    sourceUrl: url,
    extra: {
      slug: job.slug,
      tags: job.tags,
      jobTypes: job.job_types,
      location: job.location,
    },
  };
}

/** The posting's HTML description for the trap scan; `[]` when the payload is not an Arbeitnow posting. */
export function arbeitnowDescriptionHtml(payload: unknown): DescriptionHtmlFragment[] {
  const parsed = storedJobSchema.safeParse(payload);
  return parsed.success ? htmlFragments([{ path: "description", html: parsed.data.description }]) : [];
}

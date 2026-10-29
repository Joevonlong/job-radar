import { ChannelError } from "../../errors";
import { parseLocation } from "../../jobspy/parse";
import type { NormalizedPostingDraft } from "../../types";
import { httpUrlOrNull, plainText } from "../brightdata/parse";
import { jobIdOf, jobItemSchema, type JobItem } from "./contract";
import { postedAtOf } from "./posted-date";

const LINKEDIN_JOB_URL = "https://www.linkedin.com/jobs/view/";

/** Validate one raw dataset item (C6) without transforming it. Throws `ChannelError("parse")`. */
export function readJobItem(payload: unknown): JobItem {
  const parsed = jobItemSchema.safeParse(payload);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(root)");
    throw new ChannelError("parse", `Apify job record does not match the expected shape (${paths.join(", ")})`);
  }
  return parsed.data;
}

/**
 * Turn one Apify LinkedIn job record into the normalized draft. Shares the Bright Data plain-text and URL helpers
 * and the LinkedIn job id, so the same job delivered by either channel dedupes as one.
 */
export function parseApifyJob(payload: unknown): NormalizedPostingDraft {
  const item = readJobItem(payload);
  const jobId = jobIdOf(item);
  const url = httpUrlOrNull(item.url) ?? (jobId === null ? null : `${LINKEDIN_JOB_URL}${jobId}`);
  if (url === null) throw new ChannelError("parse", "Apify job record has no url and no job id");
  // the HTML keeps paragraph breaks; the plain-text field runs the lines together
  const body = item.descriptionHtml?.trim() ? item.descriptionHtml : (item.description ?? "");
  return {
    title: item.title,
    companyName: item.companyName,
    locations: parseLocation(item.location),
    // the actor does not say whether a job is remote/hybrid/on-site: unknown, never guessed (C3)
    workplace: "unknown",
    contractHint: item.contractType?.trim() || null,
    seniorityHint: item.experienceLevel?.trim() || null,
    salaryText: item.salary?.trim() || null,
    description: plainText(body),
    postedAt: postedAtOf(item.postedDate),
    applyUrl: url,
    sourceUrl: url,
    extra: { jobId, companyUrl: item.companyUrl ?? null, applyType: item.applyType ?? null },
  };
}

/** The description HTML of a stored Apify record; `[]` when there is none or the record does not match. */
export function apifyDescriptionHtml(payload: unknown): Array<{ path: string; html: string }> {
  const parsed = jobItemSchema.safeParse(payload);
  const html = parsed.success ? parsed.data.descriptionHtml : null;
  return html && html.trim() !== "" ? [{ path: "descriptionHtml", html }] : [];
}

import { currencyCodeOf } from "../../currency";
import { ChannelError } from "../../errors";
import type { NormalizedPostingDraft } from "../../types";
import { SALARY_PERIODS } from "../../types";
import { postedAtOf } from "../apify/posted-date";
import { jobRecordSchema, type JobRecord } from "./contract";

export { postedAtOf };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Plain text from the provider's summary (it may carry HTML tags and entities). */
export function plainText(value: string): string {
  return value
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      return ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/<\s*(br|\/p|\/li|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/\r/g, "")
    .replace(/[\t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Decode the entities of an HTML text (after its tags are gone, so an escaped "<b>" stays text). */
function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) return codePointOr(Number.parseInt(entity.slice(2), 16), match);
    if (entity.startsWith("#")) return codePointOr(Number.parseInt(entity.slice(1), 10), match);
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function codePointOr(value: number, fallback: string): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : fallback;
}

/**
 * The provider's formatted description (HTML) as plain text that keeps its structure: paragraphs and
 * headings become blank-line separated blocks, list items become "- " lines, line breaks stay.
 */
function htmlToText(value: string): string {
  return decodeEntities(
    value
      .replace(/<\s*(?:script|style)\b[^>]*>[\s\S]*?<\s*\/\s*(?:script|style)\s*>/gi, " ")
      .replace(/<\s*\/\s*(?:p|h[1-6]|div|section|ul|ol|table)\s*>/gi, "\n\n")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*li\b[^>]*>/gi, "\n- ")
      .replace(/<\s*\/\s*tr\s*>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\r/g, "")
    .replace(/[\t \u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The description: the formatted HTML when the provider sent it (it has the paragraphs and lists), else the one-paragraph summary. */
function descriptionOf(job: JobRecord): string {
  const formatted = job.job_description_formatted ? htmlToText(job.job_description_formatted) : "";
  if (formatted !== "") return formatted;
  return job.job_summary ? plainText(job.job_summary) : "";
}

export function httpUrlOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function periodOf(value: string | null | undefined): (typeof SALARY_PERIODS)[number] | null {
  const v = value?.trim().toLowerCase();
  if (!v) return null;
  if (/^(?:hr|hour|hourly)$/.test(v)) return "hour";
  if (/^(?:day|daily)$/.test(v)) return "day";
  if (/^(?:wk|week|weekly)$/.test(v)) return "week";
  if (/^(?:mo|month|monthly)$/.test(v)) return "month";
  if (/^(?:yr|year|annual|annually|yearly)$/.test(v)) return "year";
  return null;
}

/** Salary only when the source states amounts, a 3-letter currency and a known period (C3: no guessing). */
function salaryOf(job: JobRecord, rawText: string | null): NormalizedPostingDraft["salary"] {
  const base = job.base_salary;
  if (!base) return null;
  const min = base.min_amount ?? null;
  const max = base.max_amount ?? null;
  // the dataset writes the symbol ("€"), not the ISO code
  const currency = currencyCodeOf(base.currency);
  const period = periodOf(base.payment_period);
  if ((min === null && max === null) || currency === null || period === null) return null;
  if (min !== null && max !== null && min > max) return null;
  return {
    min,
    max,
    currency,
    period,
    raw: rawText ?? JSON.stringify({ currency, min, max, period }),
  };
}

/** Validate one raw record (C6) without transforming it. Throws `ChannelError("parse")`. */
export function readJobRecord(payload: unknown): JobRecord {
  const parsed = jobRecordSchema.safeParse(payload);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(root)");
    throw new ChannelError("parse", `Bright Data job record does not match the expected shape (${paths.join(", ")})`);
  }
  return parsed.data;
}

/** Turn one Bright Data job record into the normalized draft. */
export function parseBrightDataJob(payload: unknown): NormalizedPostingDraft {
  const job = readJobRecord(payload);
  const url = httpUrlOrNull(job.url);
  if (url === null) throw new ChannelError("parse", "Bright Data job record has no valid url");
  const rawSalary = job.job_base_pay_range?.trim() || null;
  const label = job.job_location?.trim();
  const countryCode = job.country_code?.trim().toUpperCase();
  const salary = salaryOf(job, rawSalary);
  return {
    title: job.job_title,
    companyName: job.company_name,
    locations: label
      ? [
          {
            label,
            city: label.split(",")[0]?.trim() || null,
            countryCode: countryCode && /^[A-Z]{2}$/.test(countryCode) ? countryCode : null,
          },
        ]
      : [],
    // the dataset does not say whether a job is remote/hybrid/on-site: unknown, never guessed (C3)
    workplace: "unknown",
    contractHint: job.job_employment_type?.trim() || null,
    seniorityHint: job.job_seniority_level?.trim() || null,
    salaryText: rawSalary,
    ...(salary ? { salary } : {}),
    description: descriptionOf(job),
    postedAt: postedAtOf(job.job_posted_date),
    applyUrl: httpUrlOrNull(job.apply_link) ?? url,
    sourceUrl: url,
    extra: { companyId: job.company_id ?? null },
  };
}

/** The formatted (HTML) description of a stored Bright Data record; `[]` when there is none or the record does not match. */
export function brightDataDescriptionHtml(payload: unknown): Array<{ path: string; html: string }> {
  const parsed = jobRecordSchema.safeParse(payload);
  const html = parsed.success ? parsed.data.job_description_formatted : null;
  return html && html.trim() !== "" ? [{ path: "job_description_formatted", html }] : [];
}

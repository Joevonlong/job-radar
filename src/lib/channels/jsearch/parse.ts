import { ChannelError } from "../errors";
import type { NormalizedPostingDraft } from "../types";
import { cleanUrl, rankApplyLinks } from "./apply";
import { payloadSchema, type JsearchJob } from "./schema";

/** `job_salary_period` as the API spells it → period. Other values keep the text only (C3: no guessing). */
const SALARY_PERIODS: Readonly<Record<string, "year" | "month" | "week" | "day" | "hour">> = {
  YEAR: "year",
  MONTH: "month",
  WEEK: "week",
  DAY: "day",
  HOUR: "hour",
};

const EMPLOYMENT_TYPES: Readonly<Record<string, string>> = {
  FULLTIME: "full-time",
  PARTTIME: "part-time",
  CONTRACTOR: "contract",
  INTERN: "internship",
};

const WORK_ARRANGEMENTS: Readonly<Record<string, NormalizedPostingDraft["workplace"]>> = {
  onsite: "onsite",
  hybrid: "hybrid",
  remote: "remote",
};

/** Currency symbols / codes a salary string states; the structured fields carry no currency. */
const CURRENCY_MARKERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/€|\bEUR\b/i, "EUR"],
  [/£|\bGBP\b/i, "GBP"],
  [/\bCHF\b/i, "CHF"],
  [/\$|\bUSD\b/i, "USD"],
];

function clean(value: string | null | undefined): string | undefined {
  const result = value?.replace(/[\s ]+/g, " ").trim();
  return result ? result : undefined;
}

/** Publication time of a record: the UTC datetime, else the Unix timestamp. */
export function postedAt(job: Pick<JsearchJob, "job_posted_at_datetime_utc" | "job_posted_at_timestamp">): Date | null {
  if (job.job_posted_at_datetime_utc) {
    const date = new Date(job.job_posted_at_datetime_utc);
    if (!Number.isNaN(date.getTime())) return date;
  }
  if (typeof job.job_posted_at_timestamp === "number" && job.job_posted_at_timestamp > 0) {
    const date = new Date(job.job_posted_at_timestamp * 1000);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/** The record with the detail's non-null fields laid over the search record's. */
function merge(search: JsearchJob, detail: JsearchJob | null | undefined): JsearchJob {
  if (!detail) return search;
  return { ...search, ...Object.fromEntries(Object.entries(detail).filter(([, value]) => value !== null && value !== undefined)) } as JsearchJob;
}

function workplace(job: JsearchJob): NormalizedPostingDraft["workplace"] {
  const stated = job.work_arrangement ? WORK_ARRANGEMENTS[job.work_arrangement.toLowerCase()] : undefined;
  if (stated) return stated;
  // `false` only says "not fully remote": the posting may still be on-site or hybrid
  return job.job_is_remote === true ? "remote" : "unknown";
}

function contractHint(job: JsearchJob): string | null {
  const types = (job.job_employment_types ?? []).map((type) => EMPLOYMENT_TYPES[type.toUpperCase()] ?? type.toLowerCase().replace(/_/g, " "));
  if (types.length > 0) return [...new Set(types)].join(", ");
  return clean(job.job_employment_type)?.toLowerCase() ?? null;
}

function salary(job: JsearchJob): { text: string | null; salary: NormalizedPostingDraft["salary"] } {
  const min = typeof job.job_min_salary === "number" && job.job_min_salary > 0 ? job.job_min_salary : null;
  const max = typeof job.job_max_salary === "number" && job.job_max_salary > 0 ? job.job_max_salary : null;
  const stated = clean(job.job_salary_string) ?? clean(job.job_salary);
  const period = job.job_salary_period ? SALARY_PERIODS[job.job_salary_period.toUpperCase()] : undefined;
  if (min === null && max === null) return { text: stated ?? null, salary: null };

  const code = clean(job.job_salary_currency)?.toUpperCase();
  const currency = code && /^[A-Z]{3}$/.test(code) ? code : (CURRENCY_MARKERS.find(([marker]) => marker.test(stated ?? ""))?.[1] ?? null);
  const amount = min !== null && max !== null && min !== max ? `${min}-${max}` : String(min ?? max);
  const text = stated ?? `${amount}${currency ? ` ${currency}` : ""}${period ? `/${period}` : ""}`;
  // without a stated currency or period the number cannot be compared with anything: keep the text only
  if (currency === null || period === undefined || (min !== null && max !== null && min > max)) return { text, salary: null };
  return { text, salary: { min, max, currency, period, raw: text } };
}

function locations(job: JsearchJob): NormalizedPostingDraft["locations"] {
  const city = clean(job.job_city) ?? null;
  const label = clean(job.job_location) ?? city;
  if (!label) return [];
  const country = clean(job.job_country)?.toUpperCase();
  return [{ label, city, countryCode: country && /^[A-Z]{2}$/.test(country) ? country : null }];
}

function omitEmpty(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== null));
}

/**
 * Convert a stored `{ search, detail }` payload into the normalized draft (C3: unstated facts stay
 * unknown). `applyPublisherPreference` orders the non-direct apply links (sources.yaml).
 */
export function parseJsearchPayload(payload: unknown, applyPublisherPreference: readonly string[]): NormalizedPostingDraft {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(root)");
    throw new ChannelError("parse", `jsearch payload does not match the expected shape (${paths.join(", ")})`);
  }
  const job = merge(parsed.data.search, parsed.data.detail);

  const title = clean(job.job_title);
  if (!title) throw new ChannelError("parse", "jsearch posting has no title");
  const companyName = clean(job.employer_name);
  if (!companyName) throw new ChannelError("parse", "jsearch posting has no employer name");

  const links = rankApplyLinks(job, applyPublisherPreference);
  const best = links[0] ?? null;
  const pay = salary(job);
  const description = job.job_description?.trim() ?? "";

  return {
    title,
    companyName,
    locations: locations(job),
    workplace: workplace(job),
    contractHint: contractHint(job),
    seniorityHint: clean(job.seniority_level) ?? null,
    salaryText: pay.text,
    salary: pay.salary,
    description,
    postedAt: postedAt(job),
    applyUrl: best?.url ?? null,
    // the listing page of the first publisher: a plain page whose 404 means "gone" (the Google panel link never does)
    sourceUrl: cleanUrl(job.job_apply_link) ?? best?.url ?? null,
    extra: omitEmpty({
      jobId: job.job_id,
      publisher: clean(job.job_publisher),
      applyPublisher: best?.publisher ?? undefined,
      applyIsDirect: best?.direct,
      applyLinks: links.length,
      employerWebsite: clean(job.employer_website),
      googleLink: clean(job.job_google_link),
      hasDescription: description !== "",
    }),
  };
}

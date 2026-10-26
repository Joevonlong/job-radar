import { z } from "zod";

import { ChannelError } from "../errors";
import { normalizedPostingDraftSchema, SALARY_PERIODS, type NormalizedPostingDraft } from "../types";

/** Shared `parse` for the three jobspy channels: one sidecar record → `NormalizedPostingDraft`. */

const optionalString = z.string().nullish();

/** The jobspy columns the parser reads. Everything else stays in the raw payload untouched. */
const jobspyRecordSchema = z.looseObject({
  id: optionalString,
  site: optionalString,
  job_url: optionalString,
  job_url_direct: optionalString,
  title: optionalString,
  company: optionalString,
  location: optionalString,
  date_posted: optionalString,
  job_type: optionalString,
  salary_source: optionalString,
  interval: optionalString,
  min_amount: z.number().nullish(),
  max_amount: z.number().nullish(),
  currency: optionalString,
  is_remote: z.boolean().nullish(),
  job_level: optionalString,
  job_function: optionalString,
  listing_type: optionalString,
  description: optionalString,
  company_industry: optionalString,
  company_url: optionalString,
  company_url_direct: optionalString,
  company_num_employees: optionalString,
});
type JobspyRecord = z.infer<typeof jobspyRecordSchema>;

type SalaryPeriod = (typeof SALARY_PERIODS)[number];

const PERIOD_BY_INTERVAL: Readonly<Record<string, SalaryPeriod>> = {
  yearly: "year",
  monthly: "month",
  weekly: "week",
  daily: "day",
  hourly: "hour",
};

const httpUrl = z.url({ protocol: /^https?$/ });

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function validUrl(value: string | null | undefined): string | null {
  const candidate = clean(value);
  return candidate !== null && httpUrl.safeParse(candidate).success ? candidate : null;
}

// ---------------------------------------------------------------- locations

let countryByName: Map<string, string> | undefined;
let regionNames: Intl.DisplayNames | undefined;

function regions(): Intl.DisplayNames {
  regionNames ??= new Intl.DisplayNames(["en"], { type: "region", fallback: "code" });
  return regionNames;
}

/** Country names (English and German, as LinkedIn words them) → ISO 3166-1 alpha-2, built once from Intl. */
function countryCodeFromName(name: string): string | null {
  if (countryByName === undefined) {
    countryByName = new Map();
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (const locale of ["en", "de"]) {
      const names = new Intl.DisplayNames([locale], { type: "region", fallback: "none" });
      for (const a of letters) {
        for (const b of letters) {
          const code = `${a}${b}`;
          const label = names.of(code);
          if (label !== undefined && label !== code) countryByName.set(label.toLowerCase(), code);
        }
      }
    }
  }
  return countryByName.get(name.trim().toLowerCase()) ?? null;
}

/** Intl also knows obsolete aliases, reserved territories and groups that are not ISO country assignments. */
export function isRegionCode(code: string): boolean {
  return /^[A-Z]{2}$/.test(code) && !/^(?:AC|CP|CQ|DG|EA|EU|EZ|IC|QO|TA|UN|X[A-Z]|ZZ)$/.test(code) &&
    new Intl.Locale(`und-${code}`).region === code && regions().of(code) !== code;
}

/**
 * `"Berlin, BE, DE"` (Indeed: city, state, ISO country) and `"Berlin, Berlin, Germany"` / `"Germany"`
 * (LinkedIn: country spelled out) → one location. A country that cannot be identified stays null (C3).
 */
export function parseLocation(raw: string | null | undefined): NormalizedPostingDraft["locations"] {
  const label = clean(raw);
  if (label === null) return [];
  const parts = label.split(",").map((p) => p.trim()).filter((p) => p !== "");
  const last = parts.at(-1) ?? label;
  let countryCode: string | null = null;
  let countryIsLast = false;
  if (parts.length >= 3 && isRegionCode(last.toUpperCase()) && last === last.toUpperCase()) {
    countryCode = last;
    countryIsLast = true;
  } else {
    countryCode = countryCodeFromName(last);
    countryIsLast = countryCode !== null;
  }
  const cityParts = countryIsLast ? parts.slice(0, -1) : parts;
  return [{ label, city: cityParts[0] ?? null, countryCode }];
}

// ---------------------------------------------------------------- salary

function salaryOf(record: JobspyRecord): NonNullable<NormalizedPostingDraft["salary"]> | null {
  const min = record.min_amount ?? null;
  const max = record.max_amount ?? null;
  const interval = clean(record.interval);
  const currency = clean(record.currency)?.toUpperCase() ?? null;
  const period = interval === null ? undefined : PERIOD_BY_INTERVAL[interval.toLowerCase()];
  // No guessing (C3): without a known period and currency, or with a nonsensical range, there is no structured salary.
  if ((min === null && max === null) || period === undefined || currency === null || !/^[A-Z]{3}$/.test(currency)) return null;
  if (min !== null && max !== null && min > max) return null;
  if ((min ?? 0) < 0 || (max ?? 0) < 0) return null;
  return { min, max, currency, period, raw: `${min ?? ""}-${max ?? ""} ${currency}/${period}` };
}

// ---------------------------------------------------------------- parse

function pickExtra(record: JobspyRecord): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  const add = (key: string, value: string | null | undefined): void => {
    const cleaned = clean(value);
    if (cleaned !== null) extra[key] = cleaned;
  };
  add("site", record.site);
  add("jobspyId", record.id);
  add("jobFunction", record.job_function);
  add("listingType", record.listing_type);
  add("companyIndustry", record.company_industry);
  add("companyUrl", record.company_url);
  add("companyUrlDirect", record.company_url_direct);
  add("companyNumEmployees", record.company_num_employees);
  add("salarySource", record.salary_source);
  return extra;
}

/**
 * jobspy record → draft. A posting without title or company is a parse failure (the pipeline skips
 * it); `is_remote: false` is jobspy's keyword guess, so only `true` becomes `remote` (C3).
 */
export function parseJobspyPosting(payload: unknown): NormalizedPostingDraft {
  const parsed = jobspyRecordSchema.safeParse(payload);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(root)");
    throw new ChannelError("parse", `jobspy posting does not match the expected shape (${paths.join(", ")})`);
  }
  const record = parsed.data;
  const title = clean(record.title);
  const companyName = clean(record.company);
  if (title === null) throw new ChannelError("parse", "jobspy posting has no title");
  if (companyName === null) throw new ChannelError("parse", "jobspy posting has no company");

  const sourceUrl = validUrl(record.job_url);
  const salary = salaryOf(record);
  const posted = clean(record.date_posted);
  const postedAt = posted === null || Number.isNaN(new Date(posted).getTime()) ? null : new Date(posted);

  const draft = {
    title,
    companyName,
    locations: parseLocation(record.location),
    workplace: record.is_remote === true ? ("remote" as const) : ("unknown" as const),
    contractHint: clean(record.job_type),
    seniorityHint: clean(record.job_level),
    salaryText: salary === null ? null : salary.raw,
    salary,
    description: clean(record.description) ?? "",
    postedAt,
    applyUrl: validUrl(record.job_url_direct) ?? sourceUrl,
    sourceUrl,
    extra: pickExtra(record),
  };
  const checked = normalizedPostingDraftSchema.safeParse(draft);
  if (!checked.success) {
    const paths = checked.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(root)");
    throw new ChannelError("parse", `jobspy posting failed validation (${paths.join(", ")})`);
  }
  return checked.data;
}

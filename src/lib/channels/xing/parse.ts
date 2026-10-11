import { ChannelError } from "../errors";
import { redactJobText } from "../web/redact";
import { parseDate } from "../web/select";
import type { NormalizedPostingDraft } from "../types";
import { payloadSchema, type XingDetail, type XingListItem } from "./schema";

const EMPLOYMENT_TYPES: Readonly<Record<string, string>> = {
  FULL_TIME: "full-time",
  PART_TIME: "part-time",
  CONTRACTOR: "freelance contractor",
  INTERN: "internship (student)",
  SEASONAL: "seasonal",
  TEMPORARY: "temporary position",
  VOLUNTARY: "voluntary",
  OTHER: "other",
};

/** The list shows only XING's German label for the employment type. */
const EMPLOYMENT_LABELS: Readonly<Record<string, string>> = {
  vollzeit: "full-time",
  teilzeit: "part-time",
  "selbstständig": "freelance contractor",
  studierende: "internship (student)",
  saisonarbeit: "seasonal",
  aushilfe: "temporary position",
  ehrenamt: "voluntary",
};

const SALARY_UNITS: Readonly<Record<string, "year" | "month" | "week" | "day" | "hour">> = {
  YEAR: "year",
  MONTH: "month",
  WEEK: "week",
  DAY: "day",
  HOUR: "hour",
};

function clean(value: string | null | undefined): string | null {
  const text = value?.replace(/[\s ]+/g, " ").trim();
  return text ? text : null;
}

function httpUrlOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapLocations(item: XingListItem, detail: XingDetail | null): NormalizedPostingDraft["locations"] {
  const source = detail?.job?.locations ?? item.locations ?? (item.location ? [item.location] : []);
  const seen = new Set<string>();
  const out: NormalizedPostingDraft["locations"] = [];
  for (const place of source) {
    const city = clean(place.city);
    if (!city) continue;
    const country = place.country?.countryCode?.trim().toUpperCase() ?? null;
    const code = country !== null && /^[A-Z]{2}$/.test(country) ? country : null;
    const key = `${city.toLowerCase()}|${code ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: city, city, countryCode: code });
  }
  return out;
}

/** FULL_REMOTE alone is remote, NON_REMOTE alone is on-site; every mix (and PARTLY_REMOTE) is hybrid. No detail: unknown. */
function workplace(detail: XingDetail | null): NormalizedPostingDraft["workplace"] {
  const options = detail?.job?.remoteOptions ?? [];
  if (options.length === 0) return "unknown";
  const full = options.includes("FULL_REMOTE");
  const none = options.includes("NON_REMOTE");
  const partly = options.includes("PARTLY_REMOTE");
  if (partly || (full && none)) return "hybrid";
  if (full) return "remote";
  return none ? "onsite" : "unknown";
}

function contractHint(item: XingListItem, detail: XingDetail | null): string | null {
  const ld = detail?.jsonLd?.employmentType;
  const types = (Array.isArray(ld) ? ld : [ld]).filter((t): t is string => typeof t === "string");
  const hints = types.map((t) => EMPLOYMENT_TYPES[t] ?? t.toLowerCase().replace(/_/g, " "));
  if (hints.length === 0) {
    const entity = detail?.job?.employmentType ?? item.employmentType;
    const id = entity?.id?.split(".")[0];
    const label = clean(entity?.localizationValue)?.toLowerCase();
    if (id) hints.push(EMPLOYMENT_TYPES[id] ?? id.toLowerCase().replace(/_/g, " "));
    else if (label) hints.push(EMPLOYMENT_LABELS[label] ?? label);
  }
  return hints.length > 0 ? [...new Set(hints)].join(", ") : null;
}

interface Pay {
  min: number | null;
  max: number | null;
  currency: string;
}

function pay(min: number | null | undefined, max: number | null | undefined, currency: string | null | undefined): Pay | null {
  const lo = min !== null && min !== undefined && min > 0 ? min : null;
  const hi = max !== null && max !== undefined && max > 0 ? max : null;
  if (lo === null && hi === null) return null;
  return { min: lo, max: hi, currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : "EUR" };
}

function ldSalaryPeriod(detail: XingDetail | null): "year" | "month" | "week" | "day" | "hour" | null {
  const base = detail?.jsonLd?.baseSalary;
  const value = isRecord(base) ? base.value : null;
  const unit = isRecord(value) && typeof value.unitText === "string" ? value.unitText.toUpperCase() : "";
  return SALARY_UNITS[unit] ?? null;
}

function amountText(p: Pay, period: string | null): string {
  const amount = p.min !== null && p.max !== null && p.min !== p.max ? `${p.min}-${p.max}` : String(p.min ?? p.max);
  return `${amount} ${p.currency}${period ? `/${period}` : ""}`;
}

function descriptionOf(detail: XingDetail | null): string {
  const fromLd = detail?.jsonLd?.description;
  if (typeof fromLd === "string" && fromLd.trim() !== "") return redactJobText(fromLd).trim();
  return (detail?.sections ?? [])
    .map((s) => (s.title ? `${s.title}\n${s.text}` : s.text))
    .join("\n\n")
    .trim();
}

function organizationName(detail: XingDetail | null): string | null {
  const org = detail?.jsonLd?.hiringOrganization;
  return isRecord(org) && typeof org.name === "string" ? clean(org.name) : null;
}

function omitEmpty(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined && v !== null));
}

/** Convert a stored `{ url, list, detail }` payload into the normalized draft (C3: unstated facts stay unknown). */
export function parseXingPayload(payload: unknown): NormalizedPostingDraft {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(root)");
    throw new ChannelError("parse", `xing payload does not match the expected shape (${paths.join(", ")})`);
  }
  const { url, list, detail } = parsed.data;
  const job = detail?.job ?? null;
  const ld = detail?.jsonLd ?? null;

  const title = clean(typeof ld?.title === "string" ? ld.title : null) ?? clean(job?.title) ?? clean(list.title);
  if (!title) throw new ChannelError("parse", "xing posting has no title");
  const companyName = organizationName(detail) ?? clean(job?.companyInfo?.companyNameOverride) ?? clean(list.companyInfo?.companyNameOverride);
  if (!companyName) throw new ChannelError("parse", "xing posting has no employer name");

  // Only a `SalaryRange` is the employer's own figure; a `SalaryEstimate` is XING's guess (C3).
  const salary = job?.salary ?? list.salary ?? null;
  const stated = salary?.__typename === "SalaryRange" ? pay(salary.minimum, salary.maximum, salary.currency) : null;
  const estimate = salary?.__typename === "SalaryEstimate" ? pay(salary.minimum, salary.maximum, salary.currency) : null;
  const period = stated ? ldSalaryPeriod(detail) : null;
  const language = clean(job?.language)?.toLowerCase();
  const description = descriptionOf(detail);
  const sourceUrl = httpUrlOrNull(job?.url) ?? httpUrlOrNull(list.url) ?? httpUrlOrNull(url);
  const ownApplyUrl = job?.application?.__typename === "UrlApplication" ? httpUrlOrNull(job.application.applyUrl) : null;

  return {
    title,
    companyName,
    locations: mapLocations(list, detail),
    workplace: workplace(detail),
    contractHint: contractHint(list, detail),
    seniorityHint: clean(job?.careerLevel?.localizationValue),
    salaryText: stated ? amountText(stated, period) : null,
    salary:
      stated && period && !(stated.min !== null && stated.max !== null && stated.min > stated.max)
        ? { min: stated.min, max: stated.max, currency: stated.currency, period, raw: amountText(stated, period) }
        : null,
    description,
    descriptionLanguage: language && /^[a-z]{2}$/.test(language) ? language : "unknown",
    postedAt: parseDate(job?.activatedAt) ?? parseDate(typeof ld?.datePosted === "string" ? ld.datePosted : null),
    applyUrl: ownApplyUrl ?? sourceUrl,
    sourceUrl,
    extra: omitEmpty({
      xingId: list.id.split(".")[0],
      slug: list.slug,
      refreshedAt: list.refreshedAt,
      validThrough: typeof ld?.validThrough === "string" ? ld.validThrough : job?.activeUntil,
      remoteOptions: job?.remoteOptions,
      discipline: clean(job?.discipline?.localizationValue),
      industry: clean(job?.industry?.localizationValue),
      keywords: job?.keywords,
      thirdPartyApply: list.redirectsToThirdPartyUrl,
      estimatedSalary: estimate ? { min: estimate.min, max: estimate.max, currency: estimate.currency } : undefined,
      hasDescription: description !== "",
    }),
  };
}

import { createHash } from "node:crypto";

import { z } from "zod";

import { ChannelError } from "../../errors";
import { isRegionCode } from "../../jobspy/parse";
import type { NormalizedPostingDraft } from "../../types";
import { jobIdOf } from "../apify/contract";
import { httpUrlOrNull, postedAtOf } from "../brightdata/parse";

const text = z.string().nullish();
const salarySchema = z.object({
  text,
  min: z.number().nonnegative().nullish(),
  max: z.number().nonnegative().nullish(),
  currency: text,
  payPeriod: text,
  providedByEmployer: z.boolean().nullish(),
  compensationSource: z.unknown().optional(),
});

export const harvestJobSchema = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  linkedinUrl: text,
  title: z.string().trim().min(1),
  company: z.object({
    name: z.string().trim().min(1),
    id: z.union([z.string(), z.number()]).nullish(),
    linkedinUrl: text,
    website: text,
    description: text,
    logo: text,
    industry: z.unknown().optional(),
    industries: z.unknown().optional(),
    companySize: z.unknown().optional(),
  }),
  location: z.object({
    linkedinText: text,
    countryCode: text,
    parsed: z.object({ countryCode: text }).nullish(),
  }).nullish(),
  postedDate: text,
  workplaceType: text,
  employmentType: text,
  seniorityLevel: text,
  salary: salarySchema.nullish(),
  compensationSource: z.unknown().optional(),
  descriptionText: text,
  descriptionHtml: text,
  applyMethod: z.object({ companyApplyUrl: text }).nullish(),
  applicants: z.unknown().optional(),
  views: z.unknown().optional(),
  expireAt: text,
  jobState: text,
});

/** The shared LinkedIn identity, reading harvestapi's linkedinUrl rather than Apify's url. */
export function monidJobId(payload: unknown): string | null {
  const parsed = z.object({ id: z.unknown().optional(), linkedinUrl: z.unknown().optional() }).safeParse(payload);
  if (!parsed.success) return null;
  const { id, linkedinUrl } = parsed.data;
  return jobIdOf({
    id: typeof id === "string" || typeof id === "number" ? String(id) : null,
    url: typeof linkedinUrl === "string" ? linkedinUrl : null,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/** Stable quarantine identity; its raw payload is retained while parse deliberately fails. */
export function unidentifiedExternalId(payload: unknown): string {
  const parsed = z.json().safeParse(payload);
  if (!parsed.success) throw new ChannelError("parse", "Monid item is not JSON data");
  return `unidentified:${createHash("sha256").update(canonicalJson(parsed.data)).digest("hex")}`;
}

const workplaceMap = { on_site: "onsite", hybrid: "hybrid", remote: "remote" } as const;
const periodMap = { YEARLY: "year", MONTHLY: "month", WEEKLY: "week", DAILY: "day", HOURLY: "hour" } as const;

export function parseMonidJob(payload: unknown): NormalizedPostingDraft {
  const parsed = harvestJobSchema.safeParse(payload);
  if (!parsed.success) throw new ChannelError("parse", "Monid job record does not match the harvestapi shape");
  const item = parsed.data;
  const jobId = monidJobId(item);
  if (jobId === null) throw new ChannelError("parse", "Monid job record has no LinkedIn job id");
  const url = httpUrlOrNull(item.linkedinUrl);
  const label = item.location?.linkedinText?.trim();
  const countryCode = (item.location?.parsed?.countryCode ?? item.location?.countryCode)?.trim().toUpperCase();
  const workplace = z.enum(["on_site", "hybrid", "remote"]).safeParse(item.workplaceType);
  const salary = item.salary;
  const salaryText = salary?.providedByEmployer === true ? salary.text?.trim() || null : null;
  const period = z.enum(["YEARLY", "MONTHLY", "WEEKLY", "DAILY", "HOURLY"]).safeParse(salary?.payPeriod);
  const currency = salary?.currency?.trim().toUpperCase();
  const min = salary?.min ?? null;
  const max = salary?.max ?? null;
  const structuredSalary = salary?.providedByEmployer === true && period.success && currency && /^[A-Z]{3}$/.test(currency)
    && (min !== null || max !== null) && (min === null || max === null || min <= max)
    ? { min, max, currency, period: periodMap[period.data], raw: salaryText ?? JSON.stringify(salary) }
    : null;
  return {
    title: item.title,
    companyName: item.company.name,
    locations: label ? [{ label, city: null, countryCode: countryCode && isRegionCode(countryCode) ? countryCode : null }] : [],
    workplace: workplace.success ? workplaceMap[workplace.data] : "unknown",
    contractHint: item.employmentType?.trim() || null,
    seniorityHint: item.seniorityLevel?.trim() || null,
    salaryText,
    ...(structuredSalary ? { salary: structuredSalary } : {}),
    description: item.descriptionText ?? "",
    postedAt: postedAtOf(item.postedDate),
    sourceUrl: url,
    applyUrl: httpUrlOrNull(item.applyMethod?.companyApplyUrl) ?? url,
    extra: {
      jobId,
      company: item.company,
      salary: salary ?? null,
      compensationSource: salary?.compensationSource ?? item.compensationSource ?? null,
      applicants: item.applicants ?? null,
      views: item.views ?? null,
      expireAt: item.expireAt ?? null,
      jobState: item.jobState ?? null,
    },
  };
}

export function monidDescriptionHtml(payload: unknown): Array<{ path: string; html: string }> {
  const parsed = harvestJobSchema.safeParse(payload);
  const html = parsed.success ? parsed.data.descriptionHtml : null;
  return html?.trim() ? [{ path: "descriptionHtml", html }] : [];
}

import { z } from "zod";

import { ChannelError } from "@/lib/channels/errors";
import type { NormalizedPostingDraft } from "@/lib/channels/types";
import { ashbyChannelSchema } from "@/lib/config";

import type { AtsAdapter, ListedPosting } from "./collect";
import { htmlFragments, issuePaths, readEnvelopePosting, unwrapPayload } from "./envelope";
import { htmlToText } from "./text";

/**
 * Ashby public posting API (`GET /posting-api/job-board/{org}?includeCompensation=true`): one JSON
 * document with every listed posting, description and compensation included, ETag-capable.
 */

const listSchema = z.looseObject({ jobs: z.array(z.unknown()) });

const compensationComponent = z.looseObject({
  compensationType: z.string().nullable().optional(),
  interval: z.string().nullable().optional(),
  currencyCode: z.string().nullable().optional(),
  minValue: z.number().nullable().optional(),
  maxValue: z.number().nullable().optional(),
});

const jobSchema = z.looseObject({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  department: z.string().nullable().optional(),
  team: z.string().nullable().optional(),
  employmentType: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  secondaryLocations: z.array(z.looseObject({ location: z.string().nullable().optional() })).nullable().optional(),
  publishedAt: z.string().nullable().optional(),
  isListed: z.boolean().nullable().optional(),
  isRemote: z.boolean().nullable().optional(),
  workplaceType: z.string().nullable().optional(),
  address: z
    .looseObject({
      postalAddress: z
        .looseObject({
          addressLocality: z.string().nullable().optional(),
          addressCountry: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  jobUrl: z.string().nullable().optional(),
  applyUrl: z.string().nullable().optional(),
  descriptionHtml: z.string().nullable().optional(),
  descriptionPlain: z.string().nullable().optional(),
  compensation: z
    .looseObject({
      compensationTierSummary: z.string().nullable().optional(),
      scrapeableCompensationSalarySummary: z.string().nullable().optional(),
      summaryComponents: z.array(compensationComponent).nullable().optional(),
    })
    .nullable()
    .optional(),
});
type AshbyJob = z.infer<typeof jobSchema>;

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

function workplaceOf(job: AshbyJob): NormalizedPostingDraft["workplace"] {
  switch (job.workplaceType?.toLowerCase()) {
    case "remote":
      return "remote";
    case "hybrid":
      return "hybrid";
    case "onsite":
      return "onsite";
    default:
      // older boards only carry the flag; "not remote" says nothing about hybrid vs on-site (C3)
      return job.isRemote === true ? "remote" : "unknown";
  }
}

/** "1 YEAR", "1 MONTH", "1 HOUR" … Multi-unit intervals ("6 MONTH") and `NONE` give null. */
function periodOf(interval: string | null | undefined): NonNullable<NormalizedPostingDraft["salary"]>["period"] | null {
  const match = /^\s*1\s+(YEAR|MONTH|WEEK|DAY|HOUR)\s*$/i.exec(interval ?? "");
  const unit = match?.[1]?.toLowerCase();
  return unit === "year" || unit === "month" || unit === "week" || unit === "day" || unit === "hour" ? unit : null;
}

/** The aggregate salary range over all pay tiers (`summaryComponents`, type `Salary`). Bonus, commission and equity are not salary. */
function salaryOf(job: AshbyJob): { salary: NormalizedPostingDraft["salary"]; text: string | null } {
  const compensation = job.compensation;
  const text = compensation?.scrapeableCompensationSalarySummary?.trim() || compensation?.compensationTierSummary?.trim() || null;
  const component = (compensation?.summaryComponents ?? []).find((c) => c.compensationType === "Salary");
  if (!component) return { salary: null, text };
  const min = component.minValue ?? null;
  const max = component.maxValue ?? null;
  const currency = component.currencyCode?.trim().toUpperCase() ?? "";
  const period = periodOf(component.interval);
  if (period === null || !/^[A-Z]{3}$/.test(currency) || (min === null && max === null) || (min !== null && max !== null && min > max)) {
    return { salary: null, text };
  }
  return { salary: { min, max, currency, period, raw: text ?? `${currency} ${min ?? ""}–${max ?? ""}`.trim() }, text };
}

function describe(posting: unknown): ListedPosting | null {
  if (typeof posting !== "object" || posting === null) return null;
  const record = posting as Record<string, unknown>;
  const externalId = typeof record.id === "string" ? record.id.trim() : "";
  if (externalId === "") return null;
  return {
    externalId,
    title: typeof record.title === "string" ? record.title : null,
    url: typeof record.jobUrl === "string" ? record.jobUrl : null,
    postedAt: dateOrNull(typeof record.publishedAt === "string" ? record.publishedAt : null),
  };
}

export const ashbyAdapter: AtsAdapter<z.infer<typeof ashbyChannelSchema>> = {
  id: "ashby",
  settingsSchema: ashbyChannelSchema,
  boardUrl(company, settings) {
    const base = settings.api_base_url.replace(/\/+$/, "");
    const query = settings.include_compensation ? "?includeCompensation=true" : "";
    return `${base}/posting-api/job-board/${encodeURIComponent(company.token)}${query}`;
  },
  list(body) {
    const parsed = listSchema.safeParse(body);
    if (!parsed.success) {
      throw new ChannelError("parse", `ashby board response does not match the expected shape (${issuePaths(parsed.error)})`);
    }
    // an unlisted posting is not on the public career page
    return parsed.data.jobs.filter((job) => !(typeof job === "object" && job !== null && (job as { isListed?: unknown }).isListed === false));
  },
  describe,
  parse(payload) {
    const { source, posting } = unwrapPayload(payload, "ashby");
    const parsed = jobSchema.safeParse(posting);
    if (!parsed.success) {
      throw new ChannelError("parse", `ashby posting does not match the expected shape (${issuePaths(parsed.error)})`);
    }
    return toDraft(parsed.data, source.companyName);
  },
  descriptionHtml(payload) {
    const job = readEnvelopePosting(payload, "ashby", jobSchema);
    return job ? htmlFragments([{ path: "posting.descriptionHtml", html: job.descriptionHtml }]) : [];
  },
};

function toDraft(job: AshbyJob, companyName: string): NormalizedPostingDraft {
  const postal = job.address?.postalAddress;
  const primary = job.location?.trim() ?? "";
  const labels = [primary, ...(job.secondaryLocations ?? []).map((l) => l.location?.trim() ?? "")].filter((l) => l !== "");
  const city = postal?.addressLocality?.trim() || null;
  const { salary, text } = salaryOf(job);
  const description = job.descriptionPlain?.trim() || htmlToText(job.descriptionHtml ?? "");
  return {
    title: job.title,
    companyName,
    locations: [...new Set(labels)].map((label) => ({ label, city: label === primary ? city : null, countryCode: null })),
    workplace: workplaceOf(job),
    contractHint: job.employmentType?.trim() || null,
    seniorityHint: null,
    salaryText: text,
    salary: salary ?? null,
    description,
    postedAt: dateOrNull(job.publishedAt),
    applyUrl: urlOrNull(job.applyUrl) ?? urlOrNull(job.jobUrl),
    sourceUrl: urlOrNull(job.jobUrl),
    extra: {
      ats: "ashby",
      department: job.department ?? null,
      team: job.team ?? null,
      employmentType: job.employmentType ?? null,
      country: postal?.addressCountry ?? null,
      workplaceType: job.workplaceType ?? null,
    },
  };
}

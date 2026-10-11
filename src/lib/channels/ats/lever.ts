import { z } from "zod";

import { ChannelError } from "@/lib/channels/errors";
import type { NormalizedPostingDraft } from "@/lib/channels/types";
import { leverChannelSchema } from "@/lib/config";

import type { AtsAdapter, ListedPosting } from "./collect";
import { htmlFragments, issuePaths, readEnvelopePosting, unwrapPayload } from "./envelope";
import { htmlToText } from "./text";

/**
 * Lever Postings API (`GET /v0/postings/{token}?mode=json`, global host or the EU host). Ported
 * from the legacy adapter: same field mapping, minus the policy snapshot; real responses also carry
 * `lists` and `additional`, which hold requirements and often the salary, so they join the description.
 */

const listSchema = z.array(z.unknown());

const postingSchema = z.looseObject({
  id: z.string().trim().min(1),
  text: z.string().trim().min(1),
  hostedUrl: z.string().nullable().optional(),
  applyUrl: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  categories: z
    .looseObject({
      location: z.string().nullable().optional(),
      allLocations: z.array(z.string()).nullable().optional(),
      commitment: z.string().nullable().optional(),
      team: z.string().nullable().optional(),
      department: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  workplaceType: z.string().nullable().optional(),
  descriptionPlain: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  lists: z.array(z.looseObject({ text: z.string().nullable().optional(), content: z.string().nullable().optional() })).nullable().optional(),
  additionalPlain: z.string().nullable().optional(),
  additional: z.string().nullable().optional(),
  createdAt: z.number().nullable().optional(),
  salaryRange: z
    .looseObject({
      min: z.number().nullable().optional(),
      max: z.number().nullable().optional(),
      currency: z.string().nullable().optional(),
      interval: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  salaryDescriptionPlain: z.string().nullable().optional(),
});
type LeverPosting = z.infer<typeof postingSchema>;

const httpUrl = z.url({ protocol: /^https?$/ });

function urlOrNull(value: string | null | undefined): string | null {
  const parsed = httpUrl.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function dateFromMillis(value: number | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Lever says `onsite` (older docs: `on-site`), `hybrid`, `remote`, `unspecified`. */
function workplaceOf(value: string | null | undefined): NormalizedPostingDraft["workplace"] {
  switch (value?.toLowerCase()) {
    case "remote":
      return "remote";
    case "hybrid":
      return "hybrid";
    case "onsite":
    case "on-site":
      return "onsite";
    default:
      return "unknown";
  }
}

/** `per-year-salary`, `per-month-salary`, `per-hour-wage` … (legacy fixtures used `year`). `one-time` and unknown values give null. */
function periodOf(interval: string | null | undefined): "year" | "month" | "week" | "day" | "hour" | null {
  const text = interval?.toLowerCase() ?? "";
  for (const period of ["year", "month", "week", "day", "hour"] as const) {
    if (text.includes(period)) return period;
  }
  return null;
}

function salaryOf(posting: LeverPosting): { salary: NonNullable<NormalizedPostingDraft["salary"]> | null; text: string | null } {
  const range = posting.salaryRange;
  const text = posting.salaryDescriptionPlain?.trim() || null;
  if (!range) return { salary: null, text };
  const min = range.min ?? null;
  const max = range.max ?? null;
  const currency = range.currency?.trim().toUpperCase() ?? "";
  const period = periodOf(range.interval);
  const raw = text ?? `${currency} ${min ?? ""}–${max ?? ""} ${range.interval ?? ""}`.replace(/\s+/g, " ").trim();
  if (period === null || !/^[A-Z]{3}$/.test(currency) || (min === null && max === null) || (min !== null && max !== null && min > max)) {
    return { salary: null, text: raw };
  }
  return { salary: { min, max, currency, period, raw }, text: raw };
}

function descriptionOf(posting: LeverPosting): string {
  const parts: string[] = [];
  const opening = posting.descriptionPlain?.trim() || htmlToText(posting.description ?? "");
  if (opening) parts.push(opening);
  for (const list of posting.lists ?? []) {
    const heading = list.text?.trim() ?? "";
    const items = htmlToText(list.content ?? "");
    const block = [heading, items].filter((p) => p !== "").join("\n");
    if (block) parts.push(block);
  }
  const additional = posting.additionalPlain?.trim() || htmlToText(posting.additional ?? "");
  if (additional) parts.push(additional);
  return parts.join("\n\n");
}

function describe(posting: unknown): ListedPosting | null {
  if (typeof posting !== "object" || posting === null) return null;
  const record = posting as Record<string, unknown>;
  const externalId = typeof record.id === "string" ? record.id.trim() : "";
  if (externalId === "") return null;
  return {
    externalId,
    title: typeof record.text === "string" ? record.text : null,
    url: typeof record.hostedUrl === "string" ? record.hostedUrl : null,
    postedAt: dateFromMillis(typeof record.createdAt === "number" ? record.createdAt : null),
  };
}

export const leverAdapter: AtsAdapter<z.infer<typeof leverChannelSchema>> = {
  id: "lever",
  settingsSchema: leverChannelSchema,
  boardUrl(company, settings) {
    const base = (company.region === "eu" ? settings.eu_api_base_url : settings.api_base_url).replace(/\/+$/, "");
    return `${base}/v0/postings/${encodeURIComponent(company.token)}?mode=json`;
  },
  list(body) {
    const parsed = listSchema.safeParse(body);
    if (!parsed.success) {
      throw new ChannelError("parse", `lever board response does not match the expected shape (${issuePaths(parsed.error)})`);
    }
    return parsed.data;
  },
  describe,
  parse(payload) {
    const { source, posting } = unwrapPayload(payload, "lever");
    const parsed = postingSchema.safeParse(posting);
    if (!parsed.success) {
      throw new ChannelError("parse", `lever posting does not match the expected shape (${issuePaths(parsed.error)})`);
    }
    return toDraft(parsed.data, source.companyName);
  },
  descriptionHtml(payload) {
    const posting = readEnvelopePosting(payload, "lever", postingSchema);
    if (!posting) return [];
    return htmlFragments([
      { path: "posting.description", html: posting.description },
      ...(posting.lists ?? []).map((list, index) => ({ path: `posting.lists[${index}].content`, html: list.content })),
      { path: "posting.additional", html: posting.additional },
    ]);
  },
};

function toDraft(posting: LeverPosting, companyName: string): NormalizedPostingDraft {
  const categories = posting.categories ?? {};
  const allLocations = categories.allLocations?.map((l) => l.trim()).filter((l) => l !== "") ?? [];
  const labels = allLocations.length > 0 ? allLocations : categories.location?.trim() ? [categories.location.trim()] : [];
  const country = posting.country?.trim().toUpperCase() ?? "";
  // `country` belongs to the posting's primary location; only unambiguous with a single location
  const countryCode = labels.length === 1 && /^[A-Z]{2}$/.test(country) ? country : null;
  const { salary, text: salaryText } = salaryOf(posting);
  return {
    title: posting.text,
    companyName,
    locations: labels.map((label) => ({ label, city: null, countryCode })),
    workplace: workplaceOf(posting.workplaceType),
    contractHint: categories.commitment?.trim() || null,
    seniorityHint: null,
    salaryText,
    salary,
    description: descriptionOf(posting),
    postedAt: dateFromMillis(posting.createdAt),
    applyUrl: urlOrNull(posting.applyUrl) ?? urlOrNull(posting.hostedUrl),
    sourceUrl: urlOrNull(posting.hostedUrl),
    extra: {
      ats: "lever",
      team: categories.team ?? null,
      department: categories.department ?? null,
      country: posting.country ?? null,
      workplaceType: posting.workplaceType ?? null,
    },
  };
}

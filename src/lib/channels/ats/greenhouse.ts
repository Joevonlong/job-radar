import { z } from "zod";

import { ChannelError } from "@/lib/channels/errors";
import type { NormalizedPostingDraft } from "@/lib/channels/types";
import { greenhouseChannelSchema } from "@/lib/config";

import type { AtsAdapter, ListedPosting } from "./collect";
import { htmlFragments, issuePaths, readEnvelopePosting, unwrapPayload } from "./envelope";
import { htmlToText } from "./text";

/**
 * Greenhouse Job Board API (`GET /v1/boards/{token}/jobs?content=true`). Ported from the legacy
 * adapter: same field mapping, minus the policy snapshot and the 2800-character description cap.
 */

/** Top level of a board response. Individual postings are validated by `parse`, so one odd posting never costs the board. */
const listSchema = z.looseObject({ jobs: z.array(z.unknown()) });

const idSchema = z.union([z.number(), z.string()]);

const jobSchema = z.looseObject({
  id: idSchema,
  title: z.string().trim().min(1),
  absolute_url: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  first_published: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  location: z.looseObject({ name: z.string().nullable().optional() }).nullable().optional(),
  content: z.string().nullable().optional(),
  requisition_id: z.string().nullable().optional(),
  departments: z.array(z.looseObject({ name: z.string() })).optional(),
  offices: z.array(z.looseObject({ name: z.string() })).optional(),
});
type GreenhouseJob = z.infer<typeof jobSchema>;

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

/** "Berlin, Germany; München, Germany" → one entry per displayed location (offices are a taxonomy, not geography). */
export function displayedLocations(value: string): string[] {
  return [...new Set(value.split(/\s*;\s*/).map((l) => l.trim()).filter((l) => l !== ""))];
}

function workplaceOf(locationName: string): NormalizedPostingDraft["workplace"] {
  if (/remote/i.test(locationName)) return "remote";
  if (/hybrid/i.test(locationName)) return "hybrid";
  return "unknown";
}

function idString(value: unknown): string | null {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) return null;
  const text = String(parsed.data).trim();
  return text === "" ? null : text;
}

function describe(posting: unknown): ListedPosting | null {
  if (typeof posting !== "object" || posting === null) return null;
  const record = posting as Record<string, unknown>;
  const externalId = idString(record.id);
  if (externalId === null) return null;
  return {
    externalId,
    title: typeof record.title === "string" ? record.title : null,
    url: typeof record.absolute_url === "string" ? record.absolute_url : null,
    postedAt: dateOrNull(typeof record.first_published === "string" ? record.first_published : null),
  };
}

export const greenhouseAdapter: AtsAdapter<z.infer<typeof greenhouseChannelSchema>> = {
  id: "greenhouse",
  settingsSchema: greenhouseChannelSchema,
  boardUrl(company, settings) {
    const base = settings.api_base_url.replace(/\/+$/, "");
    return `${base}/v1/boards/${encodeURIComponent(company.token)}/jobs?content=true`;
  },
  list(body) {
    const parsed = listSchema.safeParse(body);
    if (!parsed.success) {
      throw new ChannelError("parse", `greenhouse board response does not match the expected shape (${issuePaths(parsed.error)})`);
    }
    return parsed.data.jobs;
  },
  describe,
  parse(payload) {
    const { source, posting } = unwrapPayload(payload, "greenhouse");
    const parsed = jobSchema.safeParse(posting);
    if (!parsed.success) {
      throw new ChannelError("parse", `greenhouse posting does not match the expected shape (${issuePaths(parsed.error)})`);
    }
    return toDraft(parsed.data, source.companyName);
  },
  descriptionHtml(payload) {
    const job = readEnvelopePosting(payload, "greenhouse", jobSchema);
    // `content` is entity-escaped HTML (`&lt;p&gt;`)
    return job ? htmlFragments([{ path: "posting.content", html: job.content, escaped: true }]) : [];
  },
};

function toDraft(job: GreenhouseJob, companyName: string): NormalizedPostingDraft {
  const locationName = job.location?.name?.trim() ?? "";
  const language = job.language?.trim().toLowerCase();
  const url = urlOrNull(job.absolute_url);
  return {
    title: job.title,
    companyName,
    locations: displayedLocations(locationName).map((label) => ({ label, city: null, countryCode: null })),
    workplace: workplaceOf(locationName),
    contractHint: null,
    seniorityHint: null,
    salaryText: null,
    salary: null,
    description: htmlToText(job.content ?? "", { escaped: true }),
    ...(language && /^[a-z]{2}$/.test(language) ? { descriptionLanguage: language } : {}),
    postedAt: dateOrNull(job.first_published),
    applyUrl: url,
    sourceUrl: url,
    extra: {
      ats: "greenhouse",
      requisitionId: job.requisition_id ?? null,
      updatedAt: job.updated_at ?? null,
      departments: (job.departments ?? []).map((d) => d.name),
      offices: (job.offices ?? []).map((o) => o.name),
      ...(workplaceOf(locationName) === "remote" ? { remoteScope: locationName } : {}),
    },
  };
}

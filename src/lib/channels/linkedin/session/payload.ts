import { z } from "zod";

import { ChannelError } from "../../errors";
import { parseLocation } from "../../jobspy/parse";
import { SALARY_PERIODS, type NormalizedPostingDraft } from "../../types";
import { httpUrlOrNull } from "../brightdata/parse";
import type { JobDetail } from "./parse-detail";
import { stripWorkModeSuffix, type ListCard } from "./parse-search";
import { htmlFragmentToText, parseSalaryLine, squash } from "./text";

/**
 * The raw payload stored for a posting read through the LinkedIn session (C1): what the pages showed, as fields. The description is kept as
 * HTML so a better parser can re-read it later (`pnpm reprocess`). No cookie, header or page chrome is stored.
 */
export const PAYLOAD_SOURCES = ["search", "recommended"] as const;
export type PayloadSource = (typeof PAYLOAD_SOURCES)[number];

const nullableText = z.string().nullish();

export const sessionPayloadSchema = z.looseObject({
  jobId: z.string().regex(/^\d{6,}$/),
  url: z.string(),
  source: z.enum(PAYLOAD_SOURCES),
  title: z.string().trim().min(1),
  companyName: z.string().trim().min(1),
  companyUrl: nullableText,
  location: nullableText,
  workplaceText: nullableText,
  employmentText: nullableText,
  seniorityText: nullableText,
  salaryText: nullableText,
  salary: z
    .object({
      min: z.number().nullable(),
      max: z.number().nullable(),
      currency: z.string().regex(/^[A-Z]{3}$/),
      period: z.enum(SALARY_PERIODS),
      raw: z.string(),
    })
    .nullish(),
  descriptionHtml: nullableText,
  postedAt: z.iso.datetime().nullish(),
  postedText: nullableText,
  applicantsText: nullableText,
  easyApply: z.boolean().optional(),
  promoted: z.boolean().optional(),
  closed: z.boolean().optional(),
  /** The posting's own page was read (false = only the list card). */
  detailFetched: z.boolean().optional(),
});
export type SessionPayload = z.infer<typeof sessionPayloadSchema>;

export interface PayloadInput {
  jobId: string;
  url: string;
  source: PayloadSource;
  card: ListCard | null;
  detail: JobDetail | null;
}

/** Merge the list card and the posting's page (the page wins; the card fills what it lacks) into the stored payload; null when title or company are unknown. */
export function buildPayload(input: PayloadInput): SessionPayload | null {
  const { card, detail } = input;
  const title = detail?.title ?? card?.title ?? null;
  const companyName = detail?.companyName ?? card?.companyName ?? null;
  if (title === null || companyName === null) return null;
  const cardLocation = stripWorkModeSuffix(card?.location ?? null);
  const postedAt = detail?.postedAt ?? card?.postedAt ?? null;
  return {
    jobId: input.jobId,
    url: input.url,
    source: input.source,
    title,
    companyName,
    companyUrl: detail?.companyUrl ?? null,
    location: stripWorkModeSuffix(detail?.location ?? null).place ?? cardLocation.place,
    workplaceText: detail?.workplaceText ?? cardLocation.mode,
    employmentText: detail?.employmentText ?? null,
    seniorityText: detail?.seniorityText ?? null,
    salaryText: detail?.salaryText ?? null,
    salary: detail?.salary ?? null,
    descriptionHtml: detail?.descriptionHtml ?? null,
    postedAt: postedAt === null ? null : postedAt.toISOString(),
    postedText: detail?.postedText ?? card?.postedText ?? null,
    applicantsText: detail?.applicantsText ?? null,
    easyApply: detail?.easyApply || card?.easyApply || false,
    promoted: card?.promoted ?? false,
    closed: detail?.closed ?? false,
    detailFetched: detail !== null,
  };
}

/** Validate one stored payload (C6) without transforming it. Throws `ChannelError("parse")`. */
export function readSessionPayload(payload: unknown): SessionPayload {
  const parsed = sessionPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(root)");
    throw new ChannelError("parse", `LinkedIn session record does not match the expected shape (${paths.join(", ")})`);
  }
  return parsed.data;
}

const WORKPLACE_PATTERNS: ReadonlyArray<readonly [RegExp, NormalizedPostingDraft["workplace"]]> = [
  [/^(?:remote|homeoffice|home office|remote work)$/i, "remote"],
  [/^hybrid$/i, "hybrid"],
  [/^(?:on-?site|vor ort|präsenz)$/i, "onsite"],
];

function workplaceOf(text: string | null | undefined): NormalizedPostingDraft["workplace"] {
  const value = squash(text);
  if (value === null) return "unknown";
  return WORKPLACE_PATTERNS.find(([pattern]) => pattern.test(value))?.[1] ?? "unknown";
}

/** One stored payload -> the normalized draft. Facts the pages did not state stay `unknown` / null (C3). */
export function parseSessionPayload(payload: unknown): NormalizedPostingDraft {
  const record = readSessionPayload(payload);
  const url = httpUrlOrNull(record.url);
  if (url === null) throw new ChannelError("parse", "LinkedIn session record has no valid url");
  const location = stripWorkModeSuffix(squash(record.location));
  const description = record.descriptionHtml ? htmlFragmentToText(record.descriptionHtml) : "";
  const postedAt = record.postedAt ? new Date(record.postedAt) : null;
  const salary = record.salary ?? parseSalaryLine(record.salaryText);
  return {
    title: record.title,
    companyName: record.companyName,
    locations: parseLocation(location.place),
    workplace: workplaceOf(record.workplaceText),
    contractHint: squash(record.employmentText),
    seniorityHint: squash(record.seniorityText),
    salaryText: squash(record.salaryText),
    salary,
    description,
    postedAt,
    applyUrl: url,
    sourceUrl: url,
    extra: {
      jobId: record.jobId,
      source: record.source,
      companyUrl: record.companyUrl ?? null,
      applicants: squash(record.applicantsText),
      easyApply: record.easyApply ?? false,
      promoted: record.promoted ?? false,
      closed: record.closed ?? false,
      detailFetched: record.detailFetched ?? false,
    },
  };
}

/** The description HTML of a stored payload (the innerHTML of the description element, inline styles kept); `[]` when none. */
export function sessionDescriptionHtml(payload: unknown): Array<{ path: string; html: string }> {
  const parsed = sessionPayloadSchema.safeParse(payload);
  const html = parsed.success ? parsed.data.descriptionHtml : null;
  return html && html.trim() !== "" ? [{ path: "descriptionHtml", html }] : [];
}

/** The page's own "reposted" label ("Reposted 2 weeks ago", "Wiedereingestellt vor 3 Tagen") of a stored payload, for the ghost job check. */
export function sessionRepostLabel(payload: unknown): string | null {
  const parsed = sessionPayloadSchema.safeParse(payload);
  const text = parsed.success ? parsed.data.postedText : null;
  return text && text.trim() !== "" ? text.trim() : null;
}

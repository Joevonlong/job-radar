/** Job facts, signals and detail outputs are built field by field from query results. */
import { z } from "zod";

import type { Permission } from "@/lib/agent-access/permissions";
import { blockShape } from "@/lib/capabilities/blocks";
import type { JobDetail } from "@/lib/db/queries/job-detail";
import type { JobCard, JobSignal } from "@/lib/db/queries/types";
import type { TrapCounts } from "@/lib/db/repos/traps";
import { LEGACY_BASE_CURRENCY } from "@/lib/domain/types";
import { getJobBlocks } from "@/lib/mcp/job-blocks";

import { breakdownBlockDto, companyBlockDto, ghostBlockDto, lifecycleBlockDto, salaryBlockDto, translationBlockDto } from "./job-analysis";
import { matchBlockDto } from "./job-match";
import { trackingBlockDto } from "./job-tracking";
import { notesBlockDto } from "./notes";
import { bounds, iso, isoOf, isoOrNull, linkDto, locationDto, notices, range, rankDto, salaryDto, storedAmount, toLinkDto, toLocationDto, toRankDto, toSalaryDto, type CleanText } from "./shared";
import { applicationDto, toApplicationDto } from "./tracking";

const jobCardShape = {
  id: z.number().int(),
  title: z.string(),
  company: z.string(),
  locations: z.array(locationDto),
  workplace: z.string(),
  contract: z.string(),
  is_agency: z.boolean(),
  german_level_required: z.string(),
  /** active | possibly_closed | closed */
  status: z.string(),
  posted_at: iso.nullable(),
  first_seen_at: iso,
  salary: salaryDto.nullable(),
  skills: z.array(z.string()),
  rank: rankDto.nullable(),
  /** `new` when there is no application yet; `archived` = ignored. */
  application_status: z.string(),
  links: z.array(linkDto),
};

export const jobCardDto = z.strictObject(jobCardShape);
export type JobCardDto = z.infer<typeof jobCardDto>;

export const amountDto = z.strictObject({
  currency: z.string(),
  /** Per year in `currency`. */
  per_year: range,
  /** The figures and period exactly as the JD gives them; null when not kept. */
  stated: z.strictObject({ min: z.number().nullable(), max: z.number().nullable(), period: z.string() }).nullable(),
  base_per_year: range.nullable(),
  base_currency: z.string().nullable(),
  period_assumed: z.boolean(),
  currency_assumed: z.boolean(),
  other_region: z.string().nullable(),
});

export const signalDto = z.strictObject({
  /** The signal category id. */
  category: z.string(),
  kind: z.string(),
  /** The amount of an amount signal; null for any other. */
  amount: amountDto.nullable(),
  /**
   * Verbatim JD quote, or the source's own salary field when `quote_source` is `structured`. A quote that overlaps an AI trap is
   * the trap marker instead; null when the JD itself is withheld (see `description.reason`).
   */
  quote: z.string().nullable(),
  /** Index of the quote in the original posting text (before trap cleaning); null for a structured quote. */
  quote_offset: z.number().int().nullable(),
  quote_source: z.string(),
  /** Found by the vocabulary rules or by the AI review. */
  extractor: z.string(),
});

export const descriptionDto = z.strictObject({
  available: z.boolean(),
  /** The cleaned JD; null when not available or when the source gave none. */
  text: z.string().nullable(),
  truncated: z.boolean(),
  /** Characters of the whole cleaned JD. */
  total_chars: z.number().int().nullable(),
  /** Why the JD is withheld: traps_disabled | settings_unreadable | not_scanned | findings_unreadable. */
  reason: z.string().nullable(),
  message: z.string().nullable(),
});
export type DescriptionDto = z.infer<typeof descriptionDto>;

export const jobDetailDto = z.strictObject({
  ...jobCardShape,
  seniority: z.string(),
  language: z.string(),
  last_seen_at: iso,
  /** Why it shows as closed: manual / gone / dormant / phrase / possibly; null when open. */
  closed_reason: z.string().nullable(),
  signals: z.array(signalDto),
  /** Trap counts of the job's last scan; null before the first scan. */
  ai_traps: z.strictObject({ traps: z.number().int(), suspicious: z.number().int() }).nullable(),
  application: applicationDto.nullable(),
  description: descriptionDto,
});
export type JobDetailDto = z.infer<typeof jobDetailDto>;

export const searchJobsOutput = z.strictObject({
  notices,
  total: z.number().int(),
  returned: z.number().int(),
  truncated: z.boolean(),
  jobs: z.array(jobCardDto),
});
export type SearchJobsOutput = z.infer<typeof searchJobsOutput>;

export const getJobOutput = z.strictObject({
  notices,
  job: jobDetailDto,
  translation: translationBlockDto.optional(),
  breakdown: breakdownBlockDto.optional(),
  salary: salaryBlockDto.optional(),
  company: companyBlockDto.optional(),
  ghost: ghostBlockDto.optional(),
  lifecycle: lifecycleBlockDto.optional(),
  match: matchBlockDto.optional(),
  tracking: trackingBlockDto.optional(),
  notes: notesBlockDto.optional(),
});
export type GetJobOutput = z.infer<typeof getJobOutput>;

export function getJobOutputFor(permissions: ReadonlySet<Permission>): z.ZodType<GetJobOutput> {
  return z.strictObject({ notices, job: jobDetailDto, ...blockShape(getJobBlocks, permissions) });
}

export function toJobCardDto(card: JobCard, clean: CleanText): JobCardDto {
  return jobCardDto.parse({
    id: card.id,
    title: clean(card.title),
    company: clean(card.companyName),
    locations: card.locations.map((location) => toLocationDto(location, clean)),
    workplace: card.workplace,
    contract: card.contract,
    is_agency: card.isAgency,
    german_level_required: card.germanLevelRequired,
    status: card.status,
    posted_at: isoOrNull(card.postedAt),
    first_seen_at: isoOf(card.firstSeenAt),
    salary: toSalaryDto(card.salary, clean),
    skills: card.skills.map(clean),
    rank: toRankDto(card.rank),
    application_status: card.applicationStatus ?? "new",
    links: card.sources.map((source) => toLinkDto(source, clean)),
  } satisfies JobCardDto);
}

/** The amount of a signal of the amount category, read the way the dashboard reads it; null for any other value. Legacy base figures are in EUR. */
function amountOf(value: unknown): z.infer<typeof amountDto> | null {
  const parsed = storedAmount.safeParse(value);
  if (!parsed.success) return null;
  const v = parsed.data;
  const perYear = v.amount != null ? { min: v.amount, max: v.amount } : { min: v.min ?? null, max: v.max ?? null };
  if (perYear.min === null && perYear.max === null) return null;
  const base = v.baseCurrency ? { range: bounds(v.basePerYear), currency: v.baseCurrency } : { range: bounds(v.eurPerYear), currency: v.eurPerYear ? LEGACY_BASE_CURRENCY : null };
  return {
    currency: v.currency,
    per_year: perYear,
    stated: v.stated ? { min: v.stated.min ?? null, max: v.stated.max ?? null, period: v.stated.period } : null,
    base_per_year: base.range,
    base_currency: base.range ? base.currency : null,
    period_assumed: v.periodAssumed,
    currency_assumed: v.currencyAssumed,
    other_region: v.otherRegion ?? null,
  };
}

/** The quote of a signal as it may be given (the trap marker in place of a trapped one), or null when it is withheld. */
export type QuoteGuard = (signal: JobSignal) => string | null;

const quoteAsIs: QuoteGuard = (signal) => signal.quote;

export function toSignalDto(signal: JobSignal, clean: CleanText, guard: QuoteGuard = quoteAsIs): z.infer<typeof signalDto> {
  const amount = amountOf(signal.value);
  const quote = guard(signal);
  return { category: signal.tier, kind: signal.kind, amount, quote: quote === null ? null : clean(quote), quote_offset: signal.quoteOffset, quote_source: signal.quoteSource, extractor: signal.extractor };
}

export function toJobDetailDto(detail: JobDetail, extra: { traps: TrapCounts | null; description: DescriptionDto; quote?: QuoteGuard }, clean: CleanText): JobDetailDto {
  return jobDetailDto.parse({
    id: detail.id,
    title: clean(detail.title),
    company: clean(detail.company.name),
    locations: detail.locations.map((location) => toLocationDto(location, clean)),
    workplace: detail.workplace,
    contract: detail.contract,
    is_agency: detail.isAgency,
    german_level_required: detail.germanLevelRequired,
    status: detail.status,
    posted_at: isoOrNull(detail.postedAt),
    first_seen_at: isoOf(detail.firstSeenAt),
    salary: toSalaryDto(detail.salary, clean),
    skills: detail.skills.map(clean),
    rank: toRankDto(detail.score),
    application_status: detail.application?.status ?? "new",
    links: detail.sources.map((source) => toLinkDto(source, clean)),
    seniority: detail.seniority,
    language: detail.language,
    last_seen_at: isoOf(detail.lastSeenAt),
    closed_reason: detail.closure.reason,
    signals: detail.signals.map((signal) => toSignalDto(signal, clean, extra.quote)),
    ai_traps: extra.traps ? { traps: extra.traps.traps, suspicious: extra.traps.suspicious } : null,
    application: toApplicationDto(detail.application),
    description: extra.description,
  } satisfies JobDetailDto);
}

/**
 * What the MCP server may return: the ONLY implementation of the MCP row of the data egress register (constitution C5, the
 * "MCP client" exit and its data scope). Every output is a zod `strictObject` built field by field from the query results, never
 * "the whole row minus some fields", so a new column can never leak by itself. Adding a field here means updating the egress
 * register in the same change; a field beyond its data scope needs a new decision record first.
 *
 * Given: job facts, source links, score numbers and rank, compensation and benefit signals with their JD quotes, the JD after
 * AI-trap cleaning, and the status, status dates, next step and interview rounds of the user's applications.
 * Never given (no switch turns them on): the profile files and profile snapshots; anything derived from the profile (match reasons,
 * gaps, filter reasons, the salary floor, the German-level deduction, the signal bonus, deal-breaker hits and visa matches); notes
 * of any kind (application notes, event notes, favorite notes); local paths (resume variants); emails; secrets; AI usage,
 * notifications and run records.
 *
 * Every string that comes from a job posting goes through the caller's `clean` (invisible characters removed, an instruction to an
 * AI replaced by the trap marker) before it is put in a DTO.
 */
import { z } from "zod";

import type { Application, ApplicationEvent } from "@/lib/db/repos/applications";
import type { TrapCounts } from "@/lib/db/repos/traps";
import type { JobDetail } from "@/lib/db/queries/job-detail";
import type { JobCard, JobLocation, JobSalary, JobSignal, JobSourceRef } from "@/lib/db/queries/types";
import { SALARY_PERIODS } from "@/lib/channels/types";
import { LEGACY_BASE_CURRENCY, OTHER_REGION_REASONS } from "@/lib/domain/types";

/** Cleans one short piece of third-party text (see `guard.ts`). */
export type CleanText = (text: string) => string;

const iso = z.string();
const range = z.strictObject({ min: z.number().nullable(), max: z.number().nullable() });

export const linkDto = z.strictObject({
  /** The source family (e.g. `greenhouse`, `linkedin`). */
  source: z.string(),
  url: z.string().nullable(),
  apply_url: z.string().nullable(),
});

export const locationDto = z.strictObject({
  label: z.string(),
  city: z.string().nullable(),
  country_code: z.string().nullable(),
});

export const salaryDto = z.strictObject({
  /** The salary text as the posting states it. */
  raw: z.string(),
  currency: z.string().nullable(),
  period: z.string().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  per_year: range.nullable(),
  /** Per year in the market's base currency, when convertible. */
  base_per_year: range.nullable(),
  base_currency: z.string().nullable(),
  /** The parser was unsure; the figures may be wrong. */
  needs_review: z.boolean(),
  /** Possibly another region's pay, and why. */
  other_region: z.string().nullable(),
  includes_variable: z.boolean().nullable(),
});

export const rankDto = z.strictObject({
  /** The value the lists sort by (0-100). */
  rank_value: z.number().nullable(),
  /** The AI fit score (0-100). */
  score: z.number().nullable(),
  /** The profile changed since; a re-score is pending. */
  stale: z.boolean(),
});

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

export const applicationDto = z.strictObject({
  status: z.string(),
  status_changed_at: iso,
  next_action: z.string().nullable(),
  next_action_at: iso.nullable(),
  interview_rounds: z.number().int(),
});

export const jobDetailDto = z.strictObject({
  ...jobCardShape,
  seniority: z.string(),
  language: z.string(),
  last_seen_at: iso,
  /** Why the job shows as (possibly) closed; null when open. */
  closed_reason: z.string().nullable(),
  signals: z.array(signalDto),
  /** Trap counts of the job's last scan; null before the first scan. */
  ai_traps: z.strictObject({ traps: z.number().int(), suspicious: z.number().int() }).nullable(),
  application: applicationDto.nullable(),
  description: descriptionDto,
});
export type JobDetailDto = z.infer<typeof jobDetailDto>;

export const historyDto = z.strictObject({ from: z.string().nullable(), to: z.string(), at: iso });

export const applicationItemDto = z.strictObject({
  job_id: z.number().int(),
  title: z.string(),
  company: z.string(),
  status: z.string(),
  status_changed_at: iso,
  days_in_status: z.number().int(),
  next_action: z.string().nullable(),
  next_action_at: iso.nullable(),
  interview_rounds: z.number().int(),
  rank_value: z.number().nullable(),
  job_status: z.string(),
  links: z.array(linkDto),
  /** Status changes, newest first (no notes). */
  history: z.array(historyDto),
});
export type ApplicationItemDto = z.infer<typeof applicationItemDto>;

/** Every result carries its notices (third-party text warning, trap header, truncation) first. */
const notices = z.array(z.string());

export const searchJobsOutput = z.strictObject({
  notices,
  total: z.number().int(),
  returned: z.number().int(),
  truncated: z.boolean(),
  jobs: z.array(jobCardDto),
});
export type SearchJobsOutput = z.infer<typeof searchJobsOutput>;

export const getJobOutput = z.strictObject({ notices, job: jobDetailDto });
export type GetJobOutput = z.infer<typeof getJobOutput>;

export const listApplicationsOutput = z.strictObject({
  notices,
  total: z.number().int(),
  returned: z.number().int(),
  truncated: z.boolean(),
  applications: z.array(applicationItemDto),
});
export type ListApplicationsOutput = z.infer<typeof listApplicationsOutput>;

// ---------------------------------------------------------------- mapping (field by field)

const isoOf = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date ? date.toISOString() : null);

function rangeOf(value: { min: number | null; max: number | null } | null | undefined): z.infer<typeof range> | null {
  return value ? { min: value.min, max: value.max } : null;
}

export function toLinkDto(source: JobSourceRef, clean: CleanText): z.infer<typeof linkDto> {
  return { source: source.family, url: source.url === null ? null : clean(source.url), apply_url: source.applyUrl === null ? null : clean(source.applyUrl) };
}

export function toLocationDto(location: JobLocation, clean: CleanText): z.infer<typeof locationDto> {
  return { label: clean(location.label), city: location.city === null ? null : clean(location.city), country_code: location.countryCode };
}

export function toSalaryDto(salary: JobSalary | null, clean: CleanText): z.infer<typeof salaryDto> | null {
  if (!salary) return null;
  return {
    raw: clean(salary.raw),
    currency: salary.currency,
    period: salary.period,
    min: salary.min,
    max: salary.max,
    per_year: rangeOf(salary.perYear),
    base_per_year: rangeOf(salary.basePerYear),
    base_currency: salary.baseCurrency,
    needs_review: salary.qualityStatus === "review",
    other_region: salary.otherRegion ?? null,
    includes_variable: salary.includesVariable ?? null,
  };
}

function toRankDto(rank: { rankValue: number | null; score: number | null; stale: boolean } | null): z.infer<typeof rankDto> | null {
  return rank ? { rank_value: rank.rankValue, score: rank.score, stale: rank.stale } : null;
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

/**
 * The parts of a stored signal value that make an amount, read leniently (values written by older versions lack some fields).
 * Only these fields are ever read; anything else in the value is dropped.
 */
const storedRange = z.object({ min: z.number().finite().nullish(), max: z.number().finite().nullish() });
const storedAmount = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  min: z.number().finite().nullish(),
  max: z.number().finite().nullish(),
  /** A fixed amount per year (older values). */
  amount: z.number().finite().nullish(),
  stated: z.object({ min: z.number().finite().nullish(), max: z.number().finite().nullish(), period: z.enum(SALARY_PERIODS) }).nullish(),
  basePerYear: storedRange.nullish(),
  eurPerYear: storedRange.nullish(),
  baseCurrency: z.string().regex(/^[A-Z]{3}$/).nullish(),
  periodAssumed: z.boolean().default(false),
  currencyAssumed: z.boolean().default(false),
  otherRegion: z.enum(OTHER_REGION_REASONS).nullish(),
});

const bounds = (r: z.infer<typeof storedRange> | null | undefined) => (r ? { min: r.min ?? null, max: r.max ?? null } : null);

/** The amount of a signal of the amount category, read the way the dashboard reads it; null for any other value. */
function amountOf(value: unknown): z.infer<typeof amountDto> | null {
  const parsed = storedAmount.safeParse(value);
  if (!parsed.success) return null;
  const v = parsed.data;
  const perYear = v.amount != null ? { min: v.amount, max: v.amount } : { min: v.min ?? null, max: v.max ?? null };
  if (perYear.min === null && perYear.max === null) return null;
  // a value stored before the base currency was configurable has its figure in EUR
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

export function toApplicationDto(application: Application | null): z.infer<typeof applicationDto> | null {
  if (!application) return null;
  return {
    status: application.status,
    status_changed_at: isoOf(application.statusChangedAt),
    next_action: application.nextAction,
    next_action_at: isoOrNull(application.nextActionAt),
    interview_rounds: application.interviewRounds,
  };
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

const DAY_MS = 86_400_000;

export function toApplicationItemDto(entry: { job: JobCard; application: Application; events: readonly ApplicationEvent[] }, now: Date, clean: CleanText): ApplicationItemDto {
  const { job, application } = entry;
  return applicationItemDto.parse({
    job_id: job.id,
    title: clean(job.title),
    company: clean(job.companyName),
    status: application.status,
    status_changed_at: isoOf(application.statusChangedAt),
    days_in_status: Math.max(0, Math.floor((now.getTime() - application.statusChangedAt.getTime()) / DAY_MS)),
    next_action: application.nextAction,
    next_action_at: isoOrNull(application.nextActionAt),
    interview_rounds: application.interviewRounds,
    rank_value: job.rank?.rankValue ?? null,
    job_status: job.status,
    links: job.sources.map((source) => toLinkDto(source, clean)),
    history: entry.events.map((event) => ({ from: event.fromStatus, to: event.toStatus, at: isoOf(event.at) })),
  } satisfies ApplicationItemDto);
}

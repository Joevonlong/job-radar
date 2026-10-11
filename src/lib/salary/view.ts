/**
 * What the job page's "salary level" and "salary lookup" cards show, read in one place (server only): the job's
 * group in the benchmark (the narrowest one that exists), its percentile there, the company's other stated salaries,
 * the deep links, and the lookup state (switch, providers, cache, quota, an unfinished request).
 */
import { SALARY_PROMPT_VERSION } from "@/lib/ai/prompts/salary";
import type { AiProviderId } from "@/lib/ai/types";
import type { AiConfig, SalaryConfig } from "@/lib/config";
import { readInitialSalaryRequest, salaryLookupProviders, salaryLookupUnrestricted, type InitialSalaryRequest } from "@/lib/control/salary-request";
import type { Db } from "@/lib/db/client";
import { countSalaryLookupRequests, findLatestSalaryLookup, findSalaryBenchmarks, getJobForSalaryLookup, listCompanySalaryFigures, salaryBenchmarkRefreshedAt, salaryTablesReady, type SalaryBenchmarkRow } from "@/lib/db/repos";

import { ANY, normCity } from "./benchmark";
import { compileFamilies } from "./families";
import { buildDeepLinks, type DeepLink } from "./links";
import { salaryLookupKey } from "./lookup";
import type { SalaryLookupResult } from "./lookup-types";
import { percentileIn, quantile, type PercentilePosition } from "./percentile";

/** Which group the card compares with, narrowest first. */
export const GROUP_LEVELS = ["city", "country", "family_country", "family"] as const;
export type GroupLevel = (typeof GROUP_LEVELS)[number];

export interface BenchmarkGroupView {
  level: GroupLevel;
  /** `jobs.seniority` value, or null for "any seniority". */
  seniority: string | null;
  /** The city as the posting names it, the ISO country code, or null (every place). */
  place: string | null;
  n: number;
  nAi: number;
  median: number;
  quantiles: number[];
}

export interface SalaryLookupView {
  id: number;
  result: SalaryLookupResult;
  provider: string | null;
  model: string | null;
  fetchedAt: string;
  expired: boolean;
}

export type LookupAvailability = "enabled" | "disabled" | "no_web_provider" | "config_error" | "not_ready";

export interface SalaryContext {
  state: "ok" | "config_error" | "not_ready";
  currency: string;
  familyId: string | null;
  familyLabel: string | null;
  /** The job's own comparable figure (base currency per year). */
  figure: number | null;
  group: BenchmarkGroupView | null;
  position: PercentilePosition | null;
  company: { count: number; median: number | null; minSample: number } | null;
  links: DeepLink[];
  includeAi: boolean;
  /** `benchmark.enabled`: when off the table is not rebuilt any more (the card says the comparison may be old). */
  benchmarkEnabled: boolean;
  /** Whether the benchmark was ever rebuilt (false right after an upgrade, until the next cycle). */
  benchmarkComputed: boolean;
  lookup: {
    availability: LookupAvailability;
    unrestricted: boolean;
    /** The providers the lookup may use, in order (for the login hint of an auth failure). */
    providers: AiProviderId[];
    latest: SalaryLookupView | null;
    initialRequest: InitialSalaryRequest | null;
    usedToday: number;
    maxPerDay: number;
    ttlDays: number;
  };
}

/** The narrowest group that exists for a job: city, country (same seniority), then any seniority in the country, then the family. */
export function pickGroup(rows: readonly SalaryBenchmarkRow[], job: { seniority: string; city: string | null; country: string | null }): { row: SalaryBenchmarkRow; level: GroupLevel } | null {
  const seniority = job.seniority.toLowerCase();
  const known = seniority !== "unknown" && seniority !== "";
  const find = (s: string, geoLevel: string, geoKey: string | null): SalaryBenchmarkRow | undefined =>
    geoKey === null ? undefined : rows.find((row) => row.seniority === s && row.geoLevel === geoLevel && row.geoKey === geoKey);
  const steps: Array<[GroupLevel, SalaryBenchmarkRow | undefined]> = [
    ["city", known ? find(seniority, "city", job.city ? normCity(job.city) : null) : undefined],
    ["country", known ? find(seniority, "country", job.country?.toUpperCase() ?? null) : undefined],
    ["family_country", find(ANY, "country", job.country?.toUpperCase() ?? null)],
    ["family", find(ANY, "all", ANY)],
  ];
  for (const [level, row] of steps) if (row) return { row, level };
  return null;
}

const quantilesOfRow = (row: SalaryBenchmarkRow): number[] => (Array.isArray(row.quantiles) ? row.quantiles.filter((value): value is number => typeof value === "number") : []);

export async function getSalaryContext(
  db: Db,
  input: { jobId: number; figure: number | null; currency: string; salary: SalaryConfig | null; ai: AiConfig | null; locale: string; now?: Date },
): Promise<SalaryContext | null> {
  const now = input.now ?? new Date();
  const job = await getJobForSalaryLookup(db, input.jobId);
  if (!job) return null;
  const empty = (state: SalaryContext["state"], availability: LookupAvailability): SalaryContext => ({
    state,
    currency: input.currency,
    familyId: null,
    familyLabel: null,
    figure: input.figure,
    group: null,
    position: null,
    company: null,
    links: input.salary ? buildDeepLinks(input.salary.deep_links, { company: job.company, title: job.title, city: job.location?.city ?? null, country: job.location?.countryCode ?? null }) : [],
    includeAi: false,
    benchmarkEnabled: input.salary?.benchmark.enabled ?? false,
    benchmarkComputed: false,
    lookup: { availability, unrestricted: false, providers: [], latest: null, initialRequest: null, usedToday: 0, maxPerDay: input.salary?.lookup.max_per_day ?? 0, ttlDays: input.salary?.lookup.ttl_days ?? 0 },
  });
  if (!input.salary) return empty("config_error", "config_error");
  if (!(await salaryTablesReady(db))) return empty("not_ready", "not_ready");
  const salary = input.salary;
  const families = compileFamilies(salary.role_families);
  const familyId = families.familyOf(job.title);
  const city = job.location?.city ?? null;
  const country = job.location?.countryCode ?? null;

  let group: BenchmarkGroupView | null = null;
  let position: PercentilePosition | null = null;
  if (familyId !== null && input.currency !== "") {
    const seniority = job.seniority.toLowerCase();
    const rows = await findSalaryBenchmarks(db, { family: familyId, seniorities: [seniority, ANY], currency: input.currency });
    const picked = pickGroup(rows, { seniority, city, country });
    if (picked) {
      const quantiles = quantilesOfRow(picked.row);
      group = {
        level: picked.level,
        seniority: picked.row.seniority === ANY ? null : picked.row.seniority,
        place: picked.level === "city" ? city : picked.level === "family" ? null : (country?.toUpperCase() ?? null),
        n: picked.row.n,
        nAi: picked.row.nAi,
        median: picked.row.median,
        quantiles,
      };
      position = input.figure !== null ? percentileIn(quantiles, input.figure) : null;
    }
  }

  const since = new Date(now.getTime() - salary.benchmark.window_days * 86_400_000);
  const companyFigures = input.currency === "" ? [] : await listCompanySalaryFigures(db, { companyId: job.companyId, excludeJobId: job.id, currency: input.currency, since });
  const sortedCompany = [...companyFigures].sort((a, b) => a - b);
  const company = { count: sortedCompany.length, median: sortedCompany.length >= salary.benchmark.min_sample ? quantile(sortedCompany, 0.5) : null, minSample: salary.benchmark.min_sample };

  const providers = input.ai ? salaryLookupProviders(input.ai) : [];
  const availability: LookupAvailability = !input.ai ? "config_error" : !salary.lookup.enabled ? "disabled" : providers.length === 0 ? "no_web_provider" : "enabled";
  const lookupKey = salaryLookupKey(job, familyId);
  const stored = await findLatestSalaryLookup(db, { lookupKey, promptVersion: SALARY_PROMPT_VERSION });
  const latest: SalaryLookupView | null = stored
    ? { id: stored.id, result: stored.result, provider: stored.provider, model: stored.model, fetchedAt: stored.fetchedAt.toISOString(), expired: stored.expiresAt <= now }
    : null;
  const initialRequest = availability === "enabled" ? await readInitialSalaryRequest(db, { jobId: job.id, lookupKey, fetchedAt: stored?.fetchedAt ?? null }) : null;
  return {
    state: "ok",
    currency: input.currency,
    familyId,
    familyLabel: familyId === null ? null : families.label(familyId, input.locale),
    figure: input.figure,
    group,
    position,
    company,
    links: buildDeepLinks(salary.deep_links, { company: job.company, title: job.title, city, country }),
    includeAi: salary.benchmark.include_ai_lookups,
    benchmarkEnabled: salary.benchmark.enabled,
    benchmarkComputed: (await salaryBenchmarkRefreshedAt(db)) !== null,
    lookup: {
      availability,
      unrestricted: input.ai ? salaryLookupUnrestricted(input.ai) : false,
      providers,
      latest,
      initialRequest,
      usedToday: availability === "enabled" ? await countSalaryLookupRequests(db, now) : 0,
      maxPerDay: salary.lookup.max_per_day,
      ttlDays: salary.lookup.ttl_days,
    },
  };
}

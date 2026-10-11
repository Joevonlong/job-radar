/**
 * Development data: the salary benchmark of the seeded jobs (rebuilt as the pipeline step would) and one fictional
 * salary lookup ("Forward Deployed Engineer" at Quillfeather Labs, provider "seed"), so the job page shows both cards
 * without any AI. Every company, figure and source here is made up.
 */
import { and, eq } from "drizzle-orm";

import { SALARY_PROMPT_VERSION } from "@/lib/ai/prompts/salary";
import { ConfigError, reloadConfig, type SalaryConfig } from "@/lib/config";
import { refreshSalaryBenchmark } from "@/lib/salary/benchmark";
import { compileFamilies } from "@/lib/salary/families";
import { salaryLookupKey } from "@/lib/salary/lookup";
import type { SalaryLookupResult } from "@/lib/salary/lookup-types";

import type { Executor } from "./executor";
import { getJobForSalaryLookup, insertSalaryLookup } from "./repos/salary-lookups";
import { salaryTablesReady } from "./repos/salary-benchmarks";
import { companies, jobs, salaryLookups } from "./schema";

const SEED_PROVIDER = "seed";

function readSalaryConfig(): SalaryConfig | null {
  try {
    return reloadConfig("salary");
  } catch (error) {
    if (error instanceof ConfigError) return null;
    throw error;
  }
}

/** The fictional lookup of the seeded "Forward Deployed Engineer" (figures in the market's base currency). */
function seedLookupResult(input: { company: string; title: string; city: string | null; country: string | null; seniority: string; currency: string }): SalaryLookupResult {
  const sources = [
    { url: "https://www.levels.fyi/companies/quillfeather-labs/salaries", host: "www.levels.fyi", site: "Levels.fyi", title: "Quillfeather Labs salaries (fictional seed)", excerpt: "Software Engineer, Berlin: median total pay 104k", trusted: true },
    { url: "https://www.glassdoor.de/Gehalt/quillfeather-labs-gehalt.htm", host: "www.glassdoor.de", site: "Glassdoor", title: "Gehälter bei Quillfeather Labs (fictional seed)", excerpt: "Forward Deployed Engineer: 88.000 € bis 110.000 € pro Jahr", trusted: true },
    { url: "https://blog.example.org/berlin-ai-salaries", host: "blog.example.org", site: "Example blog", title: "AI engineering salaries in Berlin (fictional seed)", excerpt: "Senior ML engineers at startups earn 90-120k base", trusted: false },
  ];
  const band = (title: string, seniority: string | null, min: number, max: number, median: number, sourceIndexes: number[]) => ({
    title,
    seniority,
    min,
    max,
    median,
    original: { min, max, median, currency: input.currency },
    convertible: true,
    basis: "base" as const,
    location: input.city,
    sources: sourceIndexes,
  });
  return {
    query: input,
    companyLevel: { level: "above", median: 98000, summary: "Fictional seed data: pays somewhat above comparable Berlin startups.", sources: [0, 1] },
    roleBand: band(input.title, input.seniority === "unknown" ? null : input.seniority, 88000, 110000, 98000, [1]),
    relatedRoles: [band("Machine Learning Engineer", "senior", 90000, 118000, 102000, [0, 2]), band("Solutions Engineer", "mid", 70000, 86000, 78000, [0])],
    sources,
    confidence: "medium",
    notes: "Fictional seed data for development and tests.",
    dropped: 1,
    observations: [],
  };
}

/** Rebuild the benchmark and (re)write the fictional lookup. Nothing when salary.yaml cannot be read or the tables are missing. */
export async function seedSalary(db: Executor, input: { now: Date; currency: string }): Promise<{ groups: number; lookups: number }> {
  const config = readSalaryConfig();
  if (!config || input.currency === "" || !(await salaryTablesReady(db))) return { groups: 0, lookups: 0 };
  const benchmark = await refreshSalaryBenchmark(db, { config, currency: input.currency, now: input.now });
  await db.delete(salaryLookups).where(eq(salaryLookups.provider, SEED_PROVIDER));
  const [row] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(and(eq(companies.name, "Quillfeather Labs"), eq(jobs.title, "Forward Deployed Engineer")))
    .limit(1);
  const job = row ? await getJobForSalaryLookup(db, row.id) : null;
  if (!job) return { groups: benchmark?.groups ?? 0, lookups: 0 };
  const family = compileFamilies(config.role_families).familyOf(job.title);
  const result = seedLookupResult({ company: job.company, title: job.title, city: job.location?.city ?? null, country: job.location?.countryCode ?? null, seniority: job.seniority, currency: input.currency });
  const fetchedAt = new Date(input.now.getTime() - 2 * 86_400_000);
  await insertSalaryLookup(db, {
    companyId: job.companyId,
    jobId: job.id,
    lookupKey: salaryLookupKey(job, family),
    status: "done",
    result,
    confidence: result.confidence,
    provider: SEED_PROVIDER,
    model: SEED_PROVIDER,
    promptVersion: SALARY_PROMPT_VERSION,
    errorCode: null,
    fetchedAt,
    expiresAt: new Date(fetchedAt.getTime() + config.lookup.ttl_days * 86_400_000),
  });
  return { groups: benchmark?.groups ?? 0, lookups: 1 };
}

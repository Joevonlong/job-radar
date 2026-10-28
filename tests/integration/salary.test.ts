import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { stringify } from "yaml";

import { createAiRouter, createDbUsageStore } from "@/lib/ai";
import { SALARY_PROMPT_VERSION } from "@/lib/ai/prompts/salary";
import { salarySchema, type SalaryConfig } from "@/lib/config";
import { processNextControlRequest, registerControlHandler, resetControlHandlers } from "@/lib/control";
import { createSalaryLookupHandler } from "@/lib/control/salary-lookup";
import { readInitialSalaryRequest, readSalaryLookupRequest, requestSalaryLookup } from "@/lib/control/salary-request";
import { closeDb, getDb, getFilterResults, listJobs, listMonthSalaryFigures, saveProfileSnapshot, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { getOrCreateCompany } from "@/lib/db/repos/companies";
import { insertJob } from "@/lib/db/repos/jobs";
import { countSalaryLookupRequests, findLatestSalaryLookup, listSalaryBenchmarks, replaceSalaryBenchmarks, resetSalaryTablesCache, salaryBenchmarkHasAiRows } from "@/lib/db/repos";
import { refreshSalaryBenchmark } from "@/lib/salary/benchmark";
import { runSalaryLookup, salaryLookupKey } from "@/lib/salary/lookup";
import { quantilesOf } from "@/lib/salary/percentile";
import { salaryLookupResultSchema } from "@/lib/salary/lookup-types";
import { getSalaryContext } from "@/lib/salary/view";
import { getJobForSalaryLookup } from "@/lib/db/repos/salary-lookups";
import { runFilter } from "@/lib/filter";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import { defaultContext } from "@/lib/mcp/server";
import { mcpTranslator } from "@/lib/mcp/text";
import { searchJobs } from "@/lib/mcp/tools/search-jobs";
import { compileFamilies } from "@/lib/salary/families";

import { pinnedAi, scriptedProvider } from "../ai/helpers";
import { quietLogger } from "../cycle/helpers";
import { prefs } from "../filter/helpers";
import { shippedPipeline } from "../pipeline/helpers";

const replacement = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/db/repos/salary-benchmarks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/repos/salary-benchmarks")>();
  return {
    ...actual,
    replaceSalaryBenchmarks: async (...args: Parameters<typeof actual.replaceSalaryBenchmarks>) => {
      if (replacement.fail) throw new Error("benchmark replacement failed");
      return actual.replaceSalaryBenchmarks(...args);
    },
  };
});

const url = inject("testDatabaseUrl");
const NOW = new Date("2026-10-08T10:00:00Z");
const db = () => getDb();
const FX = { fx_pivot: "EUR", fx_rates: { USD: 0.9 } };

/** Built here: the tests never depend on the shipped salary.yaml. */
function config(edit: (raw: Record<string, Record<string, unknown>>) => void = () => {}): SalaryConfig {
  const raw: Record<string, Record<string, unknown>> = {
    benchmark: { enabled: true, window_days: 365, min_sample: 3 },
    role_families: [
      { id: "ml_engineer", label: { en: "ML engineer" }, patterns: ["\\b(?:ml|machine learning|ai)\\s+engineer\\b"] },
      { id: "software_engineer", label: { en: "Software engineer" }, patterns: ["\\b(?:software|backend)\\s+engineer\\b"] },
    ] as unknown as Record<string, unknown>,
    deep_links: [{ id: "levels_fyi", label: "Levels.fyi", url: "https://www.levels.fyi/companies/{company_slug}/salaries" }] as unknown as Record<string, unknown>,
    lookup: { enabled: true, ttl_days: 30, max_per_day: 3, timeout_seconds: 60, max_searches: 4, allowed_fetch_domains: ["levels.fyi"], sanity_annual: { min: 5000, max: 2000000 }, unconvertible_max_annual: 100_000_000_000, web_search_usd: 0.01 },
  };
  edit(raw);
  return salarySchema.parse(raw);
}

const eur = (min: number | null, max: number | null) => ({
  raw: "x",
  currency: "EUR",
  period: "year",
  min,
  max,
  perYear: { min, max },
  basePerYear: { min, max },
  baseCurrency: "EUR",
  eurPerYear: { min, max },
  periodAssumed: false,
  origin: "description",
  qualityStatus: "valid",
  reasonCodes: [],
});

async function add(company: string, title: string, salary: [number, number] | null, over: { seniority?: string; city?: string; country?: string; firstSeenAt?: Date } = {}): Promise<number> {
  const c = await getOrCreateCompany(db(), { name: company, nameNorm: company.toLowerCase() });
  const job = await insertJob(db(), {
    companyId: c.id,
    title,
    titleNorm: title.toLowerCase(),
    seniority: over.seniority ?? "senior",
    salaryJson: salary ? eur(salary[0], salary[1]) : null,
    locationsJson: [{ label: `${over.city ?? "Berlin"}, ${over.country ?? "DE"}`, city: over.city ?? "Berlin", countryCode: over.country ?? "DE", isPrimary: true }],
    firstSeenAt: over.firstSeenAt ?? new Date(NOW.getTime() - 86_400_000),
  });
  return job.id;
}

const answer = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    company_level: { level: "above", annual_median: 100000, currency: "EUR", summary: "Pays above the market.", source_indexes: [0] },
    role_band: { title: "ML Engineer", seniority: "Senior", annual_min: 95000, annual_max: 115000, annual_median: 105000, currency: "EUR", basis: "base", location: "Berlin, Germany", source_indexes: [0] },
    related_roles: [],
    sources: [{ url: "https://www.levels.fyi/companies/acme/salaries", site: "Levels.fyi", title: "Acme", excerpt: "105k" }],
    confidence: "medium",
    notes: "",
    ...extra,
  });

function router(steps: Parameters<typeof scriptedProvider>[1], order: string[] = ["anthropic"]) {
  const providers = order.map((id) => scriptedProvider(id as Parameters<typeof scriptedProvider>[0], steps));
  const ai = pinnedAi((raw) => {
    (raw.tasks as Record<string, unknown>).salary_lookup = { order };
  });
  return { ai, providers, router: createAiRouter({ config: ai, providers: providers.map((p) => p.provider), usage: createDbUsageStore(db()), now: () => NOW }) };
}

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
  resetSalaryTablesCache();
});
beforeEach(() => {
  replacement.fail = false;
  resetControlHandlers();
});
afterAll(async () => {
  resetControlHandlers();
  await closeDb();
});

describe("migration", () => {
  it("has the two tables and the salary_lookup request kind", async () => {
    const tables = await db().execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' and table_name in ('salary_benchmarks', 'salary_lookups') order by 1`);
    expect(tables.map((t) => t.table_name)).toEqual(["salary_benchmarks", "salary_lookups"]);
    const kinds = await db().execute<{ enumlabel: string }>(sql`select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'control_request_kind'`);
    expect(kinds.map((k) => k.enumlabel)).toContain("salary_lookup");
  });
});

describe("benchmark", () => {
  it("is rebuilt from the comparable salaries of the window, by family, seniority and place", async () => {
    await add("Acme", "ML Engineer", [80000, 100000]);
    await add("Bolt", "Senior ML Engineer", [90000, 110000]);
    await add("Core", "AI Engineer", [100000, 120000], { city: "Munich" });
    await add("Dyno", "ML Engineer", [200000, 220000], { firstSeenAt: new Date(NOW.getTime() - 400 * 86_400_000) }); // outside the window
    await add("Echo", "ML Engineer", null); // no salary
    await add("Fizz", "Office Manager", [50000, 60000]); // no family
    const result = await refreshSalaryBenchmark(db(), { config: config(), currency: "EUR", now: NOW });
    expect(result).toEqual({ groups: 3, postings: 4, currency: "EUR" });
    const rows = await listSalaryBenchmarks(db());
    expect(rows.map((r) => `${r.roleFamily}/${r.seniority}/${r.geoLevel}/${r.geoKey}/${r.n}/${r.median}`)).toEqual([
      "ml_engineer/*/all/*/3/100000",
      "ml_engineer/*/country/DE/3/100000",
      "ml_engineer/senior/country/DE/3/100000",
    ]);
    // switched off: nothing is rebuilt, the stored rows stay
    expect(await refreshSalaryBenchmark(db(), { config: config((raw) => (raw.benchmark!.enabled = false)), currency: "EUR", now: NOW })).toBeNull();
    expect(await listSalaryBenchmarks(db())).toHaveLength(3);
  });

  it("the job page context: percentile in the narrowest group, the company's other salaries, the links", async () => {
    await add("Acme", "ML Engineer", [80000, 100000]);
    await add("Acme", "Backend Engineer", [70000, 80000]);
    await add("Bolt", "ML Engineer", [90000, 110000]);
    const self = await add("Core", "ML Engineer", [110000, 130000]);
    await refreshSalaryBenchmark(db(), { config: config(), currency: "EUR", now: NOW });
    const context = await getSalaryContext(db(), { jobId: self, figure: 120000, currency: "EUR", salary: config(), ai: pinnedAi(), locale: "en", now: NOW });
    expect(context?.staleAi).toBe(false);
    expect(context?.benchmarkComputed).toBe(true);
    expect(context?.group).toMatchObject({ level: "city", seniority: "senior", place: "Berlin", n: 3 });
    expect(context?.position).toMatchObject({ clamp: "above" });
    expect(context?.familyLabel).toBe("ML engineer");
    expect(context?.links).toEqual([{ id: "levels_fyi", label: "Levels.fyi", url: "https://www.levels.fyi/companies/core/salaries" }]);
    expect(context?.company).toEqual({ count: 0, median: null, minSample: 3 });
    const acme = await add("Acme", "AI Engineer", null);
    const acmeContext = await getSalaryContext(db(), { jobId: acme, figure: null, currency: "EUR", salary: config(), ai: pinnedAi(), locale: "en", now: NOW });
    expect(acmeContext?.company?.count).toBe(2);
    expect(acmeContext?.position).toBeNull();
    // the shipped plan of salary_lookup: claude-cli, then anthropic (both can search)
    expect(acmeContext?.lookup).toMatchObject({ availability: "enabled", unrestricted: false, latest: null, usedToday: 0, maxPerDay: 3 });
  });

  it("tells a benchmark that was never built from one that was built without a group for the job", async () => {
    const self = await add("Acme", "ML Engineer", [80000, 100000]);
    const before = await getSalaryContext(db(), { jobId: self, figure: 90000, currency: "EUR", salary: config(), ai: pinnedAi(), locale: "en", now: NOW });
    expect(before).toMatchObject({ group: null, benchmarkComputed: false, staleAi: false });
    // one posting is below min_sample: the rebuild finds no group, the table stays empty, but it has been computed
    expect(await refreshSalaryBenchmark(db(), { config: config(), currency: "EUR", now: NOW })).toMatchObject({ groups: 0 });
    expect(await listSalaryBenchmarks(db())).toHaveLength(0);
    const after = await getSalaryContext(db(), { jobId: self, figure: 90000, currency: "EUR", salary: config(), ai: pinnedAi(), locale: "en", now: NOW });
    expect(after).toMatchObject({ group: null, benchmarkComputed: true, staleAi: false });
  });
});

/** A clean family and an unrelated family containing an old AI figure. */
async function staleTable(): Promise<number> {
  const self = await add("Acme", "ML Engineer", [80000, 100000]);
  await add("Acme", "ML Engineer", [90000, 110000]);
  await add("Acme", "ML Engineer", [100000, 120000]);
  const group = { seniority: "senior", geoLevel: "city" as const, geoKey: "berlin", currency: "EUR", n: 3, median: 100000, quantiles: quantilesOf([90000, 100000, 110000]).map(Math.round) };
  await replaceSalaryBenchmarks(db(), [{ ...group, roleFamily: "ml_engineer", nAi: 0 }, { ...group, roleFamily: "software_engineer", nAi: 1 }], NOW);
  return self;
}

const contextFor = (jobId: number, salary: SalaryConfig | null = config()) => getSalaryContext(db(), { jobId, figure: 90000, currency: "EUR", salary, ai: pinnedAi(), locale: "en", now: NOW });

describe("old benchmark read guard", () => {
  it("hides even a clean family while another has AI figures, with the benchmark enabled or disabled", async () => {
    const self = await staleTable();
    expect(await salaryBenchmarkHasAiRows(db())).toBe(true);
    const on = await contextFor(self);
    expect(on).toMatchObject({ state: "ok", group: null, position: null, benchmarkComputed: false, benchmarkEnabled: true, staleAi: true });
    expect(on?.company).toEqual({ count: 2, median: null, minSample: 3 });
    const off = await contextFor(self, config((raw) => (raw.benchmark!.enabled = false)));
    expect(off).toMatchObject({ group: null, position: null, benchmarkComputed: false, benchmarkEnabled: false, staleAi: true });
    expect(await contextFor(self, null)).toMatchObject({ state: "config_error", staleAi: false });
  });

  it("keeps failed recomputations hidden and shows the posting group after a successful recomputation", async () => {
    const self = await staleTable();
    const before = await listSalaryBenchmarks(db());
    replacement.fail = true;
    await expect(refreshSalaryBenchmark(db(), { config: config(), currency: "EUR", now: NOW })).rejects.toThrow("benchmark replacement failed");
    expect(await listSalaryBenchmarks(db())).toEqual(before);
    expect(await salaryBenchmarkHasAiRows(db())).toBe(true);
    expect(await contextFor(self)).toMatchObject({ group: null, position: null, benchmarkComputed: false, staleAi: true });
    replacement.fail = false;
    expect(await refreshSalaryBenchmark(db(), { config: config(), currency: "EUR", now: NOW })).not.toBeNull();
    expect(await salaryBenchmarkHasAiRows(db())).toBe(false);
    expect(await contextFor(self)).toMatchObject({ group: { n: 3, median: 100000 }, position: { clamp: "below" }, benchmarkComputed: true, staleAi: false });
  });

  it("leaves disabled tables unchanged, and clears restored or rollback-written AI rows on the next enabled refresh", async () => {
    const self = await staleTable();
    const before = await listSalaryBenchmarks(db());
    expect(await refreshSalaryBenchmark(db(), { config: config((raw) => (raw.benchmark!.enabled = false)), currency: "EUR", now: NOW })).toBeNull();
    expect(await listSalaryBenchmarks(db())).toEqual(before);
    expect(await salaryBenchmarkHasAiRows(db())).toBe(true);
    await refreshSalaryBenchmark(db(), { config: config(), currency: "EUR", now: NOW });
    expect(await salaryBenchmarkHasAiRows(db())).toBe(false);
    // Restoring an old database or running the old writer can put AI counts back after an upgrade.
    for (let restored = 0; restored < 2; restored += 1) {
      await db().update(schema.salaryBenchmarks).set({ nAi: 1 });
      expect(await salaryBenchmarkHasAiRows(db())).toBe(true);
      expect(await contextFor(self)).toMatchObject({ group: null, staleAi: true });
      await refreshSalaryBenchmark(db(), { config: config(), currency: "EUR", now: NOW });
      expect(await salaryBenchmarkHasAiRows(db())).toBe(false);
      expect(await contextFor(self)).toMatchObject({ group: { n: 3 }, staleAi: false });
    }
    expect(await contextFor(self, config((raw) => (raw.benchmark!.enabled = false)))).toMatchObject({ group: { n: 3 }, benchmarkEnabled: false, benchmarkComputed: true, staleAi: false });
  });
});

describe("lookup", () => {
  it("runs on a web provider only, stores the checked result, serves the cache within the TTL and counts searches in ai_usage", async () => {
    const jobId = await add("Acme", "ML Engineer", [90000, 110000]);
    const { router: r, providers } = router([{ text: answer(), tokensIn: 100, tokensOut: 50, webSearches: 3 }], ["deepseek", "anthropic"]);
    const opts = { force: false, config: config(), currency: "EUR", fx: FX, logger: quietLogger, now: () => NOW };
    const first = await runSalaryLookup(db(), r, jobId, opts);
    expect(first).toMatchObject({ status: "done", cached: false, provider: "anthropic", confidence: "medium", sources: 1 });
    expect(providers[0]?.transport.calls).toHaveLength(0); // deepseek cannot search: skipped
    expect(providers[1]?.transport.calls[0]?.web).toMatchObject({ allowedDomains: ["levels.fyi"], maxSearches: 4 });
    const [row] = await db().select().from(schema.salaryLookups);
    expect(row).toMatchObject({ jobId, status: "done", provider: "anthropic", promptVersion: SALARY_PROMPT_VERSION, confidence: "medium" });
    expect(row?.expiresAt.getTime()).toBe(NOW.getTime() + 30 * 86_400_000);
    const usage = await db().select().from(schema.aiUsage).where(eq(schema.aiUsage.task, "salary_lookup"));
    expect(usage).toHaveLength(1);
    expect(Number(usage[0]?.costEstimate)).toBeGreaterThanOrEqual(0.03); // 3 searches at 0.01 USD on top of the tokens

    // the second click within the TTL: the cache, no AI call
    const second = await runSalaryLookup(db(), r, jobId, opts);
    expect(second).toMatchObject({ status: "done", cached: true });
    expect(providers[1]?.transport.calls).toHaveLength(1);
    // a forced refresh asks again
    await runSalaryLookup(db(), r, jobId, { ...opts, force: true });
    expect(providers[1]?.transport.calls).toHaveLength(2);
  });

  it("fails without a web provider, when switched off, and for a missing job", async () => {
    const jobId = await add("Acme", "ML Engineer", null);
    const { router: r, providers } = router([answer()], ["deepseek", "mimo"]);
    const opts = { force: false, config: config(), currency: "EUR", fx: FX, logger: quietLogger, now: () => NOW };
    expect(await runSalaryLookup(db(), r, jobId, opts)).toEqual({ status: "failed", error: "no_web_provider" });
    expect(providers.every((p) => p.transport.calls.length === 0)).toBe(true);
    expect(await runSalaryLookup(db(), r, jobId, { ...opts, config: config((raw) => (raw.lookup!.enabled = false)) })).toEqual({ status: "failed", error: "disabled" });
    expect(await runSalaryLookup(db(), r, 999_999, opts)).toEqual({ status: "failed", error: "not_found" });
  });

  it("AI lookups never enter the benchmark, including old rows with observations", async () => {
    await add("Acme", "ML Engineer", [80000, 100000]);
    await add("Bolt", "ML Engineer", [90000, 110000]);
    const jobId = await add("Core", "ML Engineer", [100000, 120000]);
    const { router: r } = router([answer()]);
    await runSalaryLookup(db(), r, jobId, { force: false, config: config(), currency: "EUR", fx: FX, logger: quietLogger, now: () => NOW });
    const [lookup] = await db().select().from(schema.salaryLookups);
    const result = salaryLookupResultSchema.parse(lookup?.resultJson);
    expect(result.observations).toEqual([]);
    // An upgrade leaves these old result objects intact; their observation falls in the posting group.
    await db().update(schema.salaryLookups).set({ resultJson: { ...result, observations: [{ family: "ml_engineer", seniority: "senior", city: "Berlin", country: "DE", figure: 200000 }] } }).where(eq(schema.salaryLookups.id, lookup!.id));
    expect(await refreshSalaryBenchmark(db(), { config: config(), currency: "EUR", now: NOW })).not.toBeNull();
    const rows = await listSalaryBenchmarks(db());
    expect(rows.every((row) => row.nAi === 0)).toBe(true);
    expect(rows.find((row) => row.geoLevel === "city")).toMatchObject({ n: 3, nAi: 0, median: 100000, quantiles: quantilesOf([90000, 100000, 110000]).map(Math.round) });
  });

  it("reports the originating job for own and shared lookups, and null after deletion", async () => {
    const origin = await add("Acme", "ML Engineer", null);
    const other = await add("Acme", "ML Engineer", null);
    const { router: r } = router([answer()]);
    await runSalaryLookup(db(), r, origin, { force: false, config: config(), currency: "EUR", fx: FX, logger: quietLogger, now: () => NOW });
    // A display-title change leaves the normalized lookup key unchanged.
    const title = "ML Engineer, Platform";
    await db().update(schema.jobs).set({ title }).where(eq(schema.jobs.id, origin));
    const context = (jobId: number) => getSalaryContext(db(), { jobId, figure: null, currency: "EUR", salary: config(), ai: pinnedAi(), locale: "en", now: NOW });
    expect((await context(origin))?.lookup.latest?.origin).toEqual({ jobId: origin, title });
    expect((await context(other))?.lookup.latest?.origin).toEqual({ jobId: origin, title });
    const job = await getJobForSalaryLookup(db(), other);
    const lookupKey = salaryLookupKey(job!, "ml_engineer");
    expect((await findLatestSalaryLookup(db(), { lookupKey, promptVersion: SALARY_PROMPT_VERSION }))?.origin).toEqual({ jobId: origin, title });
    await db().delete(schema.jobs).where(eq(schema.jobs.id, origin));
    expect((await findLatestSalaryLookup(db(), { lookupKey, promptVersion: SALARY_PROMPT_VERSION }))?.origin).toBeNull();
    expect((await context(other))?.lookup.latest?.origin).toBeNull();
  });
});

async function lookupBand(jobId: number, min: number, max: number): Promise<void> {
  const { router: r } = router([answer({ role_band: { title: "ML Engineer", seniority: "Senior", annual_min: min, annual_max: max, annual_median: (min + max) / 2, currency: "EUR", basis: "base", location: "Berlin, Germany", source_indexes: [0] } })]);
  expect(await runSalaryLookup(db(), r, jobId, { force: false, config: config(), currency: "EUR", fx: FX, logger: quietLogger, now: () => NOW })).toMatchObject({ status: "done" });
}

async function filterJobs(jobIds: number[], floor: number): Promise<number> {
  const preferences = prefs((raw) => Object.assign(raw, {
    target_titles: ["ML Engineer"], locations: ["Berlin"], workplace: ["onsite", "hybrid", "remote"], remote_scope: "worldwide", seniority: "all",
    salary_floor_year: floor, contracts: { allow: [], exclude: [] }, exclude_student_roles: false, exclude_companies: [], exclude_keywords: [], deal_breakers: [],
  }));
  const snapshot = await saveProfileSnapshot(db(), "preferences", stringify(preferences));
  await runFilter(db(), { preferences, snapshotId: snapshot.id, pipeline: shippedPipeline(), me: null, jobIds, logger: quietLogger });
  return snapshot.id;
}

async function searchFixtures(): Promise<{ p: number; q: number; r: number }> {
  // These jobs are separate from the salary-floor negative controls: all remain open and unfiltered.
  const p = await add("Alpha", "ML Engineer", null);
  const q = await add("Beta", "ML Engineer", [50000, 60000]);
  const r = await add("Gamma", "ML Engineer", [85000, 95000]);
  await lookupBand(p, 90000, 110000);
  await lookupBand(q, 90000, 110000);
  const snapshot = await filterJobs([p, q, r], 0);
  const stored = await getFilterResults(db(), snapshot, [p, q, r]);
  for (const id of [p, q, r]) expect(stored.get(id)?.filterResult).toBe("passed");
  expect((await db().select({ status: schema.jobs.status }).from(schema.jobs)).every((job) => job.status === "active")).toBe(true);
  return { p, q, r };
}

const listOptions = { sort: "first_seen" as const, page: 1, pageSize: 100, timezone: "Europe/Berlin" };

describe("AI lookup figures never affect salary filters or month statistics", () => {
  it("uses posting salaries for the floor even when AI bands point the other way", async () => {
    const x = await add("Alpha", "ML Engineer", null);
    const y = await add("Beta", "ML Engineer", [50000, 60000]);
    await lookupBand(x, 25000, 35000);
    await lookupBand(y, 90000, 110000);
    const snapshot = await filterJobs([x, y], 80000);
    const stored = await getFilterResults(db(), snapshot, [x, y]);
    expect(stored.get(x)?.filterResult).toBe("passed");
    expect(stored.get(x)?.filterReasons).not.toEqual(expect.arrayContaining([expect.stringMatching(/^salary_below_floor/)]));
    expect(stored.get(y)).toMatchObject({ filterResult: "filtered_out", filterReasons: expect.arrayContaining(["salary_below_floor:60000"]) });
    const month = await listMonthSalaryFigures(db(), { now: NOW, timeZone: "Europe/Berlin", currency: "EUR" });
    expect(month).toEqual([{ id: y, figure: 55000 }]);
  });

  it("list minAnnualSalary excludes unstated and below-threshold pay despite higher AI bands", async () => {
    const { r } = await searchFixtures();
    const page = await listJobs(db(), { ...listOptions, filters: { minAnnualSalary: 80000, baseCurrency: "EUR" } });
    expect(page.jobs.map((job) => job.id)).toEqual([r]);
  });

  it("MCP search_jobs min_annual_salary independently uses the posting's upper salary bound", async () => {
    const { r } = await searchFixtures();
    const ctx = defaultContext(db(), mcpSchema.parse({ enabled: true }), { text: mcpTranslator("en"), log: () => {} });
    ctx.now = () => NOW;
    ctx.timezone = () => "Europe/Berlin";
    ctx.baseCurrency = () => "EUR";
    const result = await searchJobs(ctx, { min_annual_salary: 80000, limit: 100 });
    expect(result.jobs.map((job) => job.id)).toEqual([r]);
  });

  it("salaryDisclosed and monthly figures exclude a job with only an AI band", async () => {
    const { p, q, r } = await searchFixtures();
    const page = await listJobs(db(), { ...listOptions, filters: { salaryDisclosed: true } });
    expect(page.jobs.map((job) => job.id).sort((a, b) => a - b)).toEqual([q, r]);
    expect(page.jobs.map((job) => job.id)).not.toContain(p);
    const month = await listMonthSalaryFigures(db(), { now: NOW, timeZone: "Europe/Berlin", currency: "EUR" });
    expect([...month].sort((a, b) => a.id - b.id)).toEqual([{ id: q, figure: 55000 }, { id: r, figure: 90000 }]);
  });
});

describe("requests: queue, join, quota, state", () => {
  it("queues one request, joins an open one for the same key, and enforces the daily quota atomically", async () => {
    const ai = pinnedAi();
    const a = await add("Acme", "ML Engineer", null);
    const b = await add("Acme", "ML Engineer", null); // another posting of the same role and place: same key
    const c = await add("Bolt", "ML Engineer", null);
    const d = await add("Core", "ML Engineer", null);
    const e = await add("Dyno", "ML Engineer", null);
    const salary = config();
    const first = await requestSalaryLookup(db(), { jobId: a, force: false, salary, ai, now: NOW });
    expect(first).toMatchObject({ state: "queued", existing: false });
    expect(await requestSalaryLookup(db(), { jobId: b, force: false, salary, ai, now: NOW })).toMatchObject({ state: "queued", existing: true, requestId: first.state === "queued" ? first.requestId : -1 });
    // two clicks at once for the last two slots of three: both fit; the next one does not
    const [x, y] = await Promise.all([requestSalaryLookup(db(), { jobId: c, force: false, salary, ai, now: NOW }), requestSalaryLookup(db(), { jobId: d, force: false, salary, ai, now: NOW })]);
    expect([x.state, y.state]).toEqual(["queued", "queued"]);
    expect(await requestSalaryLookup(db(), { jobId: e, force: false, salary, ai, now: NOW })).toEqual({ state: "error", error: "quota" });
    expect(await countSalaryLookupRequests(db(), NOW)).toBe(3);
    // the next day the quota is free again
    expect(await requestSalaryLookup(db(), { jobId: e, force: false, salary, ai, now: new Date(NOW.getTime() + 25 * 3_600_000) })).toMatchObject({ state: "queued" });
  });

  it("refuses when off, without a web provider, or for an unknown job; a cached result needs no request", async () => {
    const jobId = await add("Acme", "ML Engineer", null);
    const ai = pinnedAi();
    expect(await requestSalaryLookup(db(), { jobId, force: false, salary: config((raw) => (raw.lookup!.enabled = false)), ai, now: NOW })).toEqual({ state: "error", error: "disabled" });
    const noWeb = pinnedAi((raw) => ((raw.tasks as Record<string, unknown>).salary_lookup = { order: ["deepseek"] }));
    expect(await requestSalaryLookup(db(), { jobId, force: false, salary: config(), ai: noWeb, now: NOW })).toEqual({ state: "error", error: "no_web_provider" });
    expect(await requestSalaryLookup(db(), { jobId: 999_999, force: false, salary: config(), ai, now: NOW })).toEqual({ state: "error", error: "not_found" });
    expect(await requestSalaryLookup(db(), { jobId, force: false, salary: null, ai, now: NOW })).toEqual({ state: "error", error: "config_error" });
    const { router: r } = router([answer()]);
    await runSalaryLookup(db(), r, jobId, { force: false, config: config(), currency: "EUR", fx: FX, logger: quietLogger, now: () => NOW });
    expect(await requestSalaryLookup(db(), { jobId, force: false, salary: config(), ai, now: NOW })).toEqual({ state: "cached" });
    expect(await requestSalaryLookup(db(), { jobId, force: true, salary: config(), ai, now: NOW })).toMatchObject({ state: "queued" });
  });

  it("the ai-worker handler runs a queued request; the web side reads its state, and never another job's request", async () => {
    const jobId = await add("Acme", "ML Engineer", null);
    const other = await add("Bolt", "Data Engineer", null);
    const { router: r } = router([answer()]);
    registerControlHandler("salary_lookup", createSalaryLookupHandler({ createRouter: () => r, loadSettings: () => config(), loadMoney: () => ({ currency: "EUR", fx: FX }) }));
    const queued = await requestSalaryLookup(db(), { jobId, force: false, salary: config(), ai: pinnedAi(), now: NOW });
    if (queued.state !== "queued") throw new Error("not queued");
    expect(await readSalaryLookupRequest(db(), { requestId: queued.requestId, jobId })).toMatchObject({ state: "waiting", stage: "pending", queue: { ahead: 0 } });
    expect(await readSalaryLookupRequest(db(), { requestId: queued.requestId, jobId: other })).toEqual({ state: "missing" });
    await processNextControlRequest({ db: db(), signal: new AbortController().signal, logger: quietLogger, kinds: () => ["salary_lookup"] });
    expect(await readSalaryLookupRequest(db(), { requestId: queued.requestId, jobId })).toEqual({ state: "done" });
    const job = await getJobForSalaryLookup(db(), jobId);
    const key = salaryLookupKey(job!, compileFamilies(config().role_families).familyOf(job!.title));
    expect(await readInitialSalaryRequest(db(), { jobId, lookupKey: key, fetchedAt: NOW })).toBeNull();
  });

  it("the handler refuses a request queued before the lookup was switched off, and reports a failure the card can show", async () => {
    const jobId = await add("Acme", "ML Engineer", null);
    const { router: r } = router([new Error("boom")]);
    registerControlHandler("salary_lookup", createSalaryLookupHandler({ createRouter: () => r, loadSettings: () => config((raw) => (raw.lookup!.enabled = false)), loadMoney: () => ({ currency: "EUR", fx: FX }) }));
    const queued = await requestSalaryLookup(db(), { jobId, force: false, salary: config(), ai: pinnedAi(), now: NOW });
    if (queued.state !== "queued") throw new Error("not queued");
    await processNextControlRequest({ db: db(), signal: new AbortController().signal, logger: quietLogger, kinds: () => ["salary_lookup"] });
    expect(await readSalaryLookupRequest(db(), { requestId: queued.requestId, jobId })).toMatchObject({ state: "failed", error: "disabled" });
    const job = await getJobForSalaryLookup(db(), jobId);
    const key = salaryLookupKey(job!, "ml_engineer");
    expect(await readInitialSalaryRequest(db(), { jobId, lookupKey: key, fetchedAt: null })).toMatchObject({ state: "failed", error: "disabled" });
  });
});

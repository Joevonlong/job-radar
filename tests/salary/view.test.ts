// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { salarySchema } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { getSalaryContext } from "@/lib/salary/view";

const repo = vi.hoisted(() => ({
  getJobForSalaryLookup: vi.fn(),
  salaryTablesReady: vi.fn(),
  salaryBenchmarkHasAiRows: vi.fn(),
  findSalaryBenchmarks: vi.fn(),
  listCompanySalaryFigures: vi.fn(),
  findLatestSalaryLookup: vi.fn(),
  salaryBenchmarkRefreshedAt: vi.fn(),
}));
vi.mock("@/lib/db/repos", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/db/repos")>(), ...repo }));

const salary = salarySchema.parse({
  benchmark: { enabled: true, window_days: 42, min_sample: 2 },
  role_families: [{ id: "engineer", label: { en: "Engineer" }, patterns: ["engineer"] }],
  deep_links: [],
  lookup: { enabled: false, ttl_days: 12, max_per_day: 2, timeout_seconds: 30, max_searches: 2, allowed_fetch_domains: [], sanity_annual: { min: 1000, max: 999999 } },
});
const input = { jobId: 1, figure: 90000, currency: "EUR", salary, ai: null, locale: "en", now: new Date("2026-10-01T00:00:00Z") };
const db = {} as Db; // All database boundaries below are replaced with fixtures.

beforeEach(() => {
  vi.resetAllMocks();
  repo.getJobForSalaryLookup.mockResolvedValue({ id: 1, companyId: 1, title: "Engineer", titleNorm: "engineer", company: "Acme", companyNorm: "acme", seniority: "senior", location: { city: "Berlin", countryCode: "DE" } });
  repo.salaryTablesReady.mockResolvedValue(true);
  repo.salaryBenchmarkHasAiRows.mockResolvedValue(false);
  repo.findSalaryBenchmarks.mockResolvedValue([{ seniority: "senior", geoLevel: "city", geoKey: "berlin", n: 3, median: 90000, quantiles: [50000, 60000, 70000, 80000, 90000, 100000, 110000, 120000, 130000] }]);
  repo.listCompanySalaryFigures.mockResolvedValue([70000, 90000]);
  repo.findLatestSalaryLookup.mockResolvedValue(null);
  repo.salaryBenchmarkRefreshedAt.mockResolvedValue(input.now);
});

describe("salary context read guard", () => {
  it.each([true, false])("queries no benchmark groups or refresh date while stale, enabled=%s", async (enabled) => {
    repo.salaryBenchmarkHasAiRows.mockResolvedValue(true);
    const context = await getSalaryContext(db, { ...input, salary: { ...salary, benchmark: { ...salary.benchmark, enabled } } });
    expect(context).toMatchObject({ group: null, position: null, benchmarkComputed: false, staleAi: true, benchmarkEnabled: enabled, company: { count: 2, median: 80000 } });
    expect(repo.findSalaryBenchmarks).not.toHaveBeenCalled();
    expect(repo.salaryBenchmarkRefreshedAt).not.toHaveBeenCalled();
  });

  it("retains the comparison for a clean table", async () => {
    expect(await getSalaryContext(db, input)).toMatchObject({ staleAi: false, benchmarkComputed: true, group: { n: 3, median: 90000 }, position: { value: 50 } });
    expect(repo.findSalaryBenchmarks).toHaveBeenCalledOnce();
  });

  it("uses staleAi=false on config-error and tables-not-ready paths without querying the guard", async () => {
    expect(await getSalaryContext(db, { ...input, salary: null })).toMatchObject({ state: "config_error", staleAi: false });
    repo.salaryTablesReady.mockResolvedValue(false);
    expect(await getSalaryContext(db, input)).toMatchObject({ state: "not_ready", staleAi: false });
    expect(repo.salaryBenchmarkHasAiRows).not.toHaveBeenCalled();
  });
});

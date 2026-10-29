// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const floor = vi.hoisted(() => ({ currency: "CHF" as string | null }));
vi.mock("@/lib/signals/floor", () => ({
  loadBaseCurrency: () => floor.currency,
  loadHighValuePolicy: () => ({ categories: [], salaryFloor: null, baseCurrency: floor.currency }),
}));

import type { Db } from "@/lib/db";
import { jobsListFilters } from "@/lib/jobs/list-filters";
import { loadJobsSearchParams } from "@/lib/jobs/search-params";
import { buildCompanyMatchIndex } from "@/lib/pipeline/company";

import { pipelineWith } from "../pipeline/helpers";

/** /jobs compares salaries (filter and sort) in the market's base currency, not an assumed EUR. */
describe("jobsListFilters: base currency", () => {
  const params = (query: string) => loadJobsSearchParams(new URLSearchParams(query));
  const db = {} as Db;

  it("carries scope and reasons outside saved-view conversion, also for mark-all-seen", async () => {
    const filters = await jobsListFilters(db, params("scope=current&status=closed&reason=gone&reason=manual"), { cities: [], visa: false, ghost: false });
    expect(filters).toMatchObject({ scope: "current", statuses: ["closed"], closedReasons: ["manual", "gone"] });
    expect(await jobsListFilters(db, params("status=closed"), { cities: [], visa: false, ghost: false })).toMatchObject({ scope: null, statuses: ["closed"], closedReasons: [] });
  });

  it("carries the market's base currency for the salary sort and the minimum salary", async () => {
    const filters = await jobsListFilters(db, params("sort=salary&minSalary=90000"), { cities: [] });
    expect(filters.baseCurrency).toBe("CHF");
    expect(filters.minAnnualSalary).toBe(90000);
  });

  it("no resolvable market: null (nothing compares), never the EUR default", async () => {
    floor.currency = null;
    const filters = await jobsListFilters(db, params("sort=salary"), { cities: [] });
    expect(filters.baseCurrency).toBeNull();
    expect("baseCurrency" in filters).toBe(true);
  });

  it("uses the caller's company index for the list query", async () => {
    const companyIndex = buildCompanyMatchIndex([{ id: 7, name: "Acme", nameNorm: "acme", aliases: [] }], pipelineWith((raw) => {
      const company = raw.company as { aliases: Record<string, string[]>; legal_suffixes: string[] };
      company.aliases = {};
      company.legal_suffixes = ["gmbh"];
    }));
    const filters = await jobsListFilters(db, params("company=Acme"), { cities: [], visa: false, ghost: false, companyIndex });
    expect(filters.companyIds).toEqual([7]);
  });
});

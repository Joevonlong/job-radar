// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listCompanyMatchRows, type Db } from "@/lib/db";
import type { CityGroup } from "@/lib/jobs/city-groups";
import { loadPipeline } from "@/lib/market/effective";
import { buildCompanyMatchIndex } from "@/lib/pipeline/company";

import { searchPlan } from "../fixtures/job-search";
import { pipelineWith } from "../pipeline/helpers";

vi.mock("@/lib/jobs/search", async () => ({ buildSearchPlan: (await import("../fixtures/job-search")).searchPlan }));
vi.mock("@/lib/db", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/db")>(), listCompanyMatchRows: vi.fn() }));
vi.mock("@/lib/market/effective", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/market/effective")>(), loadPipeline: vi.fn() }));

import { needsCityGroups, needsCompanyIds, resolveViewCompanyIds, toJobFilters } from "@/lib/jobs/job-filters";

const group = (key: string, members: string[]): CityGroup => ({ key, members, jobCount: members.length, target: false });
const groups = [group("München", ["München", "Garching", "Munich"]), group("Berlin", ["Berlin"])];

describe("resolveViewCompanyIds", () => {
  const db = {} as Db;
  const config = pipelineWith((raw) => {
    const company = raw.company as { aliases: Record<string, string[]>; legal_suffixes: string[] };
    company.aliases = { Acme: ["Oldbrand"] };
    company.legal_suffixes = ["gmbh"];
  });
  const rows = [{ id: 1, name: "Acme", nameNorm: "acme", aliases: [] }, { id: 2, name: "N26", nameNorm: "n26", aliases: [] }];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listCompanyMatchRows).mockResolvedValue(rows);
    vi.mocked(loadPipeline).mockReturnValue(config);
  });

  it("reads neither companies nor pipeline when no set picks a company", async () => {
    expect(await resolveViewCompanyIds(db, [{}, { company: [] }])).toEqual([null, null]);
    expect(listCompanyMatchRows).not.toHaveBeenCalled();
    expect(loadPipeline).not.toHaveBeenCalled();
  });

  it("reads companies once for several sets, distinguishing no filter from no matches", async () => {
    expect(await resolveViewCompanyIds(db, [{}, { company: ["N26", "Oldbrand"] }, { company: ["Nobody"] }, { company: ["Acme"] }, { company: [] }])).toEqual([null, [1, 2], [], [1], null]);
    expect(listCompanyMatchRows).toHaveBeenCalledExactlyOnceWith(db);
    expect(loadPipeline).toHaveBeenCalledTimes(1);
  });

  it("uses the supplied pipeline instead of loading one", async () => {
    expect(await resolveViewCompanyIds(db, [{ company: ["Oldbrand"] }], { pipeline: config })).toEqual([[1]]);
    expect(listCompanyMatchRows).toHaveBeenCalledExactlyOnceWith(db);
    expect(loadPipeline).not.toHaveBeenCalled();
  });

  it("reuses the supplied index without reading companies or loading pipeline", async () => {
    const index = buildCompanyMatchIndex(rows, config);
    expect(await resolveViewCompanyIds(db, [{ company: ["Oldbrand"] }, { company: ["Nobody"] }], { index })).toEqual([[1], []]);
    expect(listCompanyMatchRows).not.toHaveBeenCalled();
    expect(loadPipeline).not.toHaveBeenCalled();
  });
});

describe("toJobFilters", () => {
  it("reads a scalar and a list the same: one-element list", () => {
    expect(toJobFilters({ city: "Berlin", workplace: "remote" }, { cityGroups: groups })).toMatchObject({ cities: ["Berlin"], workplaces: ["remote"], cityMembers: ["Berlin"] });
    expect(toJobFilters({ city: ["Berlin"], workplace: ["remote"] }, { cityGroups: groups })).toMatchObject({ cities: ["Berlin"], workplaces: ["remote"] });
  });

  it("takes the union of the members of every picked city, without duplicates", () => {
    const f = toJobFilters({ city: ["München", "Berlin", "Hamburg"] }, { cityGroups: groups });
    expect(f.cities).toEqual(["München", "Berlin", "Hamburg"]);
    expect(f.cityMembers).toEqual(["München", "Garching", "Munich", "Berlin", "Hamburg"]);
  });

  it("maps the other keys and leaves unset filters out (null)", () => {
    const f = toJobFilters({ q: "ml", source: ["ats", "xing"], contract: "permanent", status: ["active", "closed"], app: ["new"], minScore: 70, minSalary: 80000, salary: true }, { cityGroups: null });
    expect(f).toEqual({
      search: searchPlan("ml"),
      sources: ["ats", "xing"],
      companyIds: null,
      cities: null,
      cityMembers: null,
      workplaces: null,
      contracts: ["permanent"],
      statuses: ["active", "closed"],
      applicationStatuses: ["new"],
      minRank: 70,
      minAnnualSalary: 80000,
      salaryDisclosed: true,
      trap: null,
      visa: null,
      ghost: null,
    });
  });

  it("passes the ghost filter only while the check is available, and reads `all` as no filter", () => {
    expect(toJobFilters({ ghost: "only" }, { cityGroups: null, ghost: true }).ghost).toBe("only");
    expect(toJobFilters({ ghost: "hide" }, { cityGroups: null, ghost: true }).ghost).toBe("hide");
    expect(toJobFilters({ ghost: "all" }, { cityGroups: null, ghost: true }).ghost).toBeNull();
    expect(toJobFilters({ ghost: "only" }, { cityGroups: null }).ghost).toBeNull();
    expect(toJobFilters({ ghost: "only" }, { cityGroups: null, ghost: false }).ghost).toBeNull();
  });

  it("passes the resolved company ids; picked companies without ids match nothing, no company is no filter", () => {
    expect(toJobFilters({ company: ["Acme"] }, { cityGroups: null, companyIds: [3, 7] }).companyIds).toEqual([3, 7]);
    expect(toJobFilters({ company: ["Acme"] }, { cityGroups: null, companyIds: [] }).companyIds).toEqual([]);
    expect(toJobFilters({ company: ["Acme"] }, { cityGroups: null }).companyIds).toEqual([]);
    expect(toJobFilters({}, { cityGroups: null, companyIds: [3] }).companyIds).toBeNull();
    expect(needsCompanyIds({})).toBe(false);
    expect(needsCompanyIds({ company: ["Acme"] })).toBe(true);
  });

  it("needsCityGroups is true only when a city is picked", () => {
    expect(needsCityGroups({})).toBe(false);
    expect(needsCityGroups({ workplace: "remote" })).toBe(false);
    expect(needsCityGroups({ city: "Berlin" })).toBe(true);
    expect(needsCityGroups({ city: ["Berlin", "München"] })).toBe(true);
  });
});

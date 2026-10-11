// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import type { CityGroup } from "@/lib/jobs/city-groups";

vi.mock("@/lib/jobs/cities", () => ({ searchLocationTerms: (q: string | null | undefined) => (q ? [q, `${q}-alias`] : []) }));

import { needsCityGroups, toJobFilters } from "@/lib/jobs/job-filters";

const group = (key: string, members: string[]): CityGroup => ({ key, members, jobCount: members.length, target: false });
const groups = [group("München", ["München", "Garching", "Munich"]), group("Berlin", ["Berlin"])];

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
      q: "ml",
      qLocationTerms: ["ml", "ml-alias"],
      sources: ["ats", "xing"],
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

  it("needsCityGroups is true only when a city is picked", () => {
    expect(needsCityGroups({})).toBe(false);
    expect(needsCityGroups({ workplace: "remote" })).toBe(false);
    expect(needsCityGroups({ city: "Berlin" })).toBe(true);
    expect(needsCityGroups({ city: ["Berlin", "München"] })).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { matchesSyncSalaryBenchmark, matchesSyncSalaryLookup } from "@/lib/db/repos/agent-change-keys";
import { compileFamilies } from "@/lib/salary/families";
import { salaryLookupCompanyMatches, salaryLookupKey } from "@/lib/salary/lookup-key";

const families = compileFamilies([
  { id: "data", label: { en: "Data" }, patterns: ["data engineer"] },
  { id: "engineering", label: { en: "Engineering" }, patterns: ["engineer"] },
]);
const job = {
  title: "Data Engineer", titleNorm: "data engineer", companyNorm: "Café | Tools", seniority: "Senior",
  location: { label: "Example City", city: "Example City", countryCode: "gb", isPrimary: true },
};

describe("shared salary change keys", () => {
  it("requires the same normalized company, family, title, seniority and first location", () => {
    const key = salaryLookupKey(job, "data");
    expect(salaryLookupCompanyMatches("cafe tools", key)).toBe(true);
    expect(salaryLookupCompanyMatches("other company", key)).toBe(false);
    expect(matchesSyncSalaryLookup(job, key, families)).toBe(true);
    expect(matchesSyncSalaryLookup({ ...job, title: "Support Engineer" }, key, families)).toBe(false);
    expect(matchesSyncSalaryLookup({ ...job, location: null }, key, families)).toBe(false);
    expect(matchesSyncSalaryLookup({ ...job, seniority: "junior" }, key, families)).toBe(false);
  });

  it("allows a shortened company part, then requires the full hashed key to match", () => {
    const long = { ...job, companyNorm: "x".repeat(450) };
    const similar = { ...job, companyNorm: "x".repeat(449) + "y" };
    const key = salaryLookupKey(long, "data");
    expect(salaryLookupCompanyMatches(long.companyNorm, key)).toBe(true);
    expect(salaryLookupCompanyMatches(similar.companyNorm, key)).toBe(true);
    expect(matchesSyncSalaryLookup(long, key, families)).toBe(true);
    expect(matchesSyncSalaryLookup(similar, key, families)).toBe(false);
  });

  it("matches each benchmark fallback candidate including any-seniority groups", () => {
    expect(matchesSyncSalaryBenchmark(job, ["data", "senior", "city", "example city", "GBP"], families)).toBe(true);
    expect(matchesSyncSalaryBenchmark(job, ["data", "senior", "country", "GB", "GBP"], families)).toBe(true);
    expect(matchesSyncSalaryBenchmark(job, ["data", "*", "country", "GB", "GBP"], families)).toBe(true);
    expect(matchesSyncSalaryBenchmark(job, ["data", "*", "all", "*", "GBP"], families)).toBe(true);
    expect(matchesSyncSalaryBenchmark(job, ["engineering", "*", "all", "*", "GBP"], families)).toBe(false);
    expect(matchesSyncSalaryBenchmark({ ...job, seniority: "unknown" }, ["data", "senior", "city", "example city", "GBP"], families)).toBe(false);
    expect(matchesSyncSalaryBenchmark({ ...job, seniority: "unknown" }, ["data", "*", "country", "GB", "GBP"], families)).toBe(true);
    expect(matchesSyncSalaryBenchmark({ ...job, location: null }, ["data", "*", "country", "GB", "GBP"], families)).toBe(false);
  });
});

// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ChannelError } from "@/lib/channels/errors";
import { parseJobspyPosting, parseLocation } from "@/lib/channels/jobspy";
import { normalizedPostingDraftSchema } from "@/lib/channels/types";

import { loadJobspyFixture } from "./helpers";

describe("parse: Indeed fixture", () => {
  const { jobs } = loadJobspyFixture("indeed");

  it("turns the first real posting into a draft", () => {
    const draft = parseJobspyPosting(jobs[0]);
    expect(draft).toMatchObject({
      title: "Manager - Tax Data Analytics Engineer",
      companyName: "nordlicht",
      workplace: "unknown",
      contractHint: null,
      salary: null,
      applyUrl: expect.stringContaining("careers.example.com"),
      sourceUrl: "https://de.indeed.com/viewjob?jk=1a2b3c4d5e6f0001",
      locations: [{ label: "Berlin, BE, DE", city: "Berlin", countryCode: "DE" }],
    });
    expect(draft.postedAt?.toISOString()).toBe("2026-10-06T00:00:00.000Z");
    expect(draft.description).toContain("Nordlicht");
    expect(draft.extra).toMatchObject({ site: "indeed", companyUrl: "https://de.indeed.com/cmp/Nordlicht" });
  });

  it("maps is_remote true to remote and job_type to the contract hint", () => {
    expect(parseJobspyPosting(jobs[1])).toMatchObject({ workplace: "remote", contractHint: "fulltime" });
  });

  it("rejects a posting without a company as a parse error", () => {
    expect(jobs[3]?.company).toBeNull();
    expect(() => parseJobspyPosting(jobs[3])).toThrowError(ChannelError);
    expect(() => parseJobspyPosting(jobs[3])).toThrowError(/no company/);
  });

  it("every other posting passes the draft schema", () => {
    for (const job of jobs.filter((j) => j.company !== null)) {
      expect(normalizedPostingDraftSchema.safeParse(parseJobspyPosting(job)).success).toBe(true);
    }
  });
});

describe("parse: LinkedIn fixture", () => {
  const { jobs } = loadJobspyFixture("linkedin");

  it("parses guest results (no description unless fetched)", () => {
    const draft = parseJobspyPosting(jobs[0]);
    expect(draft).toMatchObject({
      title: "Senior Machine Learning Engineer",
      companyName: "Benedikt Labs",
      description: "",
      applyUrl: "https://www.linkedin.com/jobs/view/4476000001",
      sourceUrl: "https://www.linkedin.com/jobs/view/4476000001",
      locations: [{ label: "Berlin, Germany", city: "Berlin", countryCode: "DE" }],
    });
  });

  it("keeps an unrecognised location without inventing a country", () => {
    const draft = parseJobspyPosting(jobs[3]);
    expect(draft.locations).toEqual([{ label: "Berlin Metropolitan Area", city: "Berlin Metropolitan Area", countryCode: null }]);
  });

  it("parses all postings", () => {
    expect(jobs.map((j) => parseJobspyPosting(j).title)).toHaveLength(jobs.length);
  });
});

describe("parse: Google fixture", () => {
  const { jobs } = loadJobspyFixture("google");

  it("falls back to the job URL when there is no direct URL", () => {
    const draft = parseJobspyPosting(jobs[0]);
    expect(draft.applyUrl).toBe(draft.sourceUrl);
    expect(draft.locations).toEqual([{ label: "Berlin, Germany", city: "Berlin", countryCode: "DE" }]);
  });

  it("reads structured salary and a missing date", () => {
    const draft = parseJobspyPosting(jobs[1]);
    expect(draft).toMatchObject({
      workplace: "remote",
      postedAt: null,
      salary: { min: 70000, max: 95000, currency: "EUR", period: "year" },
      salaryText: "70000-95000 EUR/year",
      applyUrl: "https://careers.example.org/jobs/4711",
    });
  });
});

describe("parse: edge cases", () => {
  const base = { id: "in-1", title: "T", company: "C", job_url: "https://example.test/j/1" };

  it("drops a salary it cannot read reliably (no guessing)", () => {
    expect(parseJobspyPosting({ ...base, min_amount: 50, max_amount: 60, interval: "yearly", currency: null }).salary).toBeNull();
    expect(parseJobspyPosting({ ...base, min_amount: 50, max_amount: 60, interval: "fortnightly", currency: "EUR" }).salary).toBeNull();
    expect(parseJobspyPosting({ ...base, min_amount: 90, max_amount: 60, interval: "yearly", currency: "EUR" }).salary).toBeNull();
    expect(parseJobspyPosting({ ...base, min_amount: null, max_amount: 60, interval: "hourly", currency: "eur" }).salary).toMatchObject({
      min: null,
      max: 60,
      currency: "EUR",
      period: "hour",
    });
  });

  it("ignores non-http URLs", () => {
    const draft = parseJobspyPosting({ ...base, job_url: "javascript:alert(1)", job_url_direct: "ftp://x" });
    expect(draft.sourceUrl).toBeNull();
    expect(draft.applyUrl).toBeNull();
  });

  it("rejects payloads that are not jobspy records", () => {
    expect(() => parseJobspyPosting("nope")).toThrowError(/expected shape/);
    expect(() => parseJobspyPosting({ ...base, min_amount: "50" })).toThrowError(ChannelError);
    expect(() => parseJobspyPosting({ ...base, title: "  " })).toThrowError(/no title/);
  });

  it("does not carry e-mail addresses or phone numbers into the draft", () => {
    const draft = parseJobspyPosting({ ...base, emails: "hr@example.test", phone: "+49 30 1" });
    expect(JSON.stringify(draft)).not.toMatch(/hr@example|\+49/);
  });
});

describe("parseLocation", () => {
  it.each([
    ["Berlin, BE, DE", { city: "Berlin", countryCode: "DE" }],
    ["München, BY, DE", { city: "München", countryCode: "DE" }],
    ["Berlin, Berlin, Germany", { city: "Berlin", countryCode: "DE" }],
    ["Munich, Bavaria, Deutschland", { city: "Munich", countryCode: "DE" }],
    ["Germany", { city: null, countryCode: "DE" }],
    ["Berlin, BE", { city: "Berlin", countryCode: null }],
    ["Austin, TX, US", { city: "Austin", countryCode: "US" }],
    ["Anywhere", { city: "Anywhere", countryCode: null }],
  ])("%s", (raw, expected) => {
    expect(parseLocation(raw)).toEqual([{ label: raw, ...expected }]);
  });

  it("returns no location for blank input", () => {
    expect(parseLocation(null)).toEqual([]);
    expect(parseLocation("  ")).toEqual([]);
  });
});

// @vitest-environment node
import { describe, expect, it } from "vitest";

import { fieldsOf, mergeJobFields, relatedCompanyKeys, sameCity, type JobFields } from "@/lib/pipeline/dedupe";
import { normalizeDraft } from "@/lib/pipeline/normalize";

import { draft, shippedPipeline } from "./helpers";

const config = shippedPipeline();
const fields = (over: Partial<JobFields> = {}): JobFields => ({ ...fieldsOf(normalizeDraft(draft(), config)), ...over });
const salary = (qualityStatus: "valid" | "review", max = 100000) => ({ raw: "x", qualityStatus, eurPerYear: { min: 1, max } });

describe("related company names", () => {
  it.each([
    ["siv", "siv-ag-service-fur-informationsverarbeitung"],
    ["allianz-in-deutschland", "allianz-kunde-und-markt"],
    ["acme", "acme"],
  ])("%s ~ %s", (a, b) => {
    expect(relatedCompanyKeys(a, b)).toBe(true);
    expect(relatedCompanyKeys(b, a)).toBe(true);
  });

  it("keeps unrelated names apart", () => {
    expect(relatedCompanyKeys("fahrmiete", "siv")).toBe(false);
    expect(relatedCompanyKeys("", "acme")).toBe(false);
  });
});

describe("same city", () => {
  const berlin = [{ city: "Berlin" }];
  it("matches shared cities and two location-less postings", () => {
    expect(sameCity(berlin, [{ city: "Berlin" }, { city: "München" }])).toBe(true);
    expect(sameCity([{ city: "Düsseldorf" }], [{ city: "Dusseldorf" }])).toBe(true);
    expect(sameCity([], [])).toBe(true);
    expect(sameCity([{ city: null }], [])).toBe(true);
  });
  it("does not match different cities, or a city against none", () => {
    expect(sameCity(berlin, [{ city: "München" }])).toBe(false);
    expect(sameCity(berlin, [])).toBe(false);
    expect(sameCity([], berlin)).toBe(false);
  });
});

describe("merging a new source into a job", () => {
  it("lets the better source win the fields it states", () => {
    const existing = fields({ title: "AI Engineer", seniority: "unknown", contract: "permanent", description: "linkedin text" });
    const incoming = fields({ title: "Applied AI Engineer", titleNorm: "applied ai engineer", seniority: "senior", contract: "unknown", description: "ats text" });
    const merged = mergeJobFields(existing, incoming, true);
    expect(merged).toMatchObject({ title: "Applied AI Engineer", seniority: "senior", description: "ats text" });
    expect(merged.contract).toBe("permanent"); // a known value is never replaced by unknown (C3)
  });

  it("lets a lower-priority source only fill what is unknown", () => {
    const existing = fields({ title: "AI Engineer", seniority: "unknown", description: "ats text", workplace: "unknown", language: "en", simhash: "a".repeat(16) });
    const incoming = fields({ title: "AI Engineer!!", seniority: "senior", description: "linkedin text", workplace: "remote", language: "de", simhash: "b".repeat(16) });
    const merged = mergeJobFields(existing, incoming, false);
    expect(merged).toMatchObject({ title: "AI Engineer", seniority: "senior", workplace: "remote", language: "en", description: "ats text", simhash: "a".repeat(16) });
  });

  it("takes the description and its SimHash together", () => {
    const existing = fields({ description: null, simhash: null });
    const incoming = fields({ description: "text", simhash: "c".repeat(16) });
    expect(mergeJobFields(existing, incoming, false)).toMatchObject({ description: "text", simhash: "c".repeat(16) });
    expect(mergeJobFields(fields({ description: "old", simhash: "d".repeat(16) }), fields({ description: "new", simhash: null }), true)).toMatchObject({
      description: "new",
      simhash: null,
    });
  });

  it("prefers a valid salary, then the winner's", () => {
    expect(mergeJobFields(fields({ salaryJson: null }), fields({ salaryJson: salary("valid") }), false).salaryJson).toEqual(salary("valid"));
    expect(mergeJobFields(fields({ salaryJson: salary("valid") }), fields({ salaryJson: null }), true).salaryJson).toEqual(salary("valid"));
    expect(mergeJobFields(fields({ salaryJson: salary("review") }), fields({ salaryJson: salary("valid", 5) }), false).salaryJson).toEqual(salary("valid", 5));
    expect(mergeJobFields(fields({ salaryJson: salary("valid", 1) }), fields({ salaryJson: salary("valid", 2) }), false).salaryJson).toEqual(salary("valid", 1));
    expect(mergeJobFields(fields({ salaryJson: salary("valid", 1) }), fields({ salaryJson: salary("valid", 2) }), true).salaryJson).toEqual(salary("valid", 2));
  });

  it("accumulates locations, skills and the agency flag, and keeps the earliest posting date", () => {
    const existing = fields({
      locationsJson: [{ label: "Berlin", city: "Berlin", countryCode: "DE", isPrimary: true }],
      skills: ["Python"],
      isAgency: false,
      postedAt: new Date("2026-10-03T00:00:00Z"),
    });
    const incoming = fields({
      locationsJson: [
        { label: "München", city: "München", countryCode: "DE", isPrimary: true },
        { label: "Berlin, Germany", city: "Berlin", countryCode: "DE", isPrimary: false },
      ],
      skills: ["Python", "AWS"],
      isAgency: true,
      postedAt: new Date("2026-10-01T00:00:00Z"),
    });
    const merged = mergeJobFields(existing, incoming, false);
    expect(merged.locationsJson.map((l) => `${l.city}:${l.isPrimary}`)).toEqual(["Berlin:true", "München:false"]);
    expect(merged.skills).toEqual(["Python", "AWS"]);
    expect(merged.isAgency).toBe(true);
    expect(merged.postedAt).toEqual(new Date("2026-10-01T00:00:00Z"));
  });

  it("takes the German level from the description that is kept, not from a sibling posting", () => {
    const nordics = fields({ description: "Fluency in English and one Nordic language.", germanLevelRequired: "unknown" });
    const dach = fields({ description: "Fluency in German and English (must).", germanLevelRequired: "C1" });
    expect(mergeJobFields(nordics, dach, false)).toMatchObject({ description: nordics.description, germanLevelRequired: "unknown" });
    expect(mergeJobFields(nordics, dach, true)).toMatchObject({ description: dach.description, germanLevelRequired: "C1" });
    // no description on either side: the known level still fills the unknown one
    expect(mergeJobFields(fields({ description: null, germanLevelRequired: "unknown" }), fields({ description: null, germanLevelRequired: "B2" }), false).germanLevelRequired).toBe("B2");
  });
});

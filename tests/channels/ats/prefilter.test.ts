// @vitest-environment node
import { describe, expect, it } from "vitest";

import { configRegistry, type AtsTitlePrefilterSettings } from "@/lib/config";
import { compileTermMatcher, createTitlePrefilter } from "@/lib/channels/ats/prefilter";

import { shippedYaml } from "../../config/helpers";
import { shippedPipeline } from "../../pipeline/helpers";

const KEYWORDS = { engineering: ["AI Engineer", "Machine Learning Engineer"], german: ["KI-Entwickler"], fde: ["Forward Deployed Engineer"] };
const PIPELINE = shippedPipeline();
const SETTINGS: AtsTitlePrefilterSettings = { enabled: true, include_terms: [], exclude_terms: [] };

function filter(overrides: Partial<AtsTitlePrefilterSettings> = {}, watched: string[] = []) {
  return createTitlePrefilter({ settings: { ...SETTINGS, ...overrides }, keywordGroups: KEYWORDS, watchedCompanies: watched, pipeline: PIPELINE });
}

describe("compileTermMatcher", () => {
  it("is null without terms", () => {
    expect(compileTermMatcher([])).toBeNull();
    expect(compileTermMatcher(["  "])).toBeNull();
  });

  it("matches whole words only, case-insensitively", () => {
    const m = compileTermMatcher(["AI Engineer"]);
    expect(m?.test("Senior AI Engineer (m/f/d)")).toBe(true);
    expect(m?.test("senior ai engineer")).toBe(true);
    expect(m?.test("Thai Engineer")).toBe(false);
    expect(m?.test("AI Engineers")).toBe(false);
    expect(m?.test("Applied AI Engineer")).toBe(true);
    expect(m?.test("Staff AI/ML Engineer")).toBe(false);
  });

  it("treats spaces and hyphens inside a term as interchangeable", () => {
    const m = compileTermMatcher(["KI-Entwickler"]);
    expect(m?.test("KI Entwickler")).toBe(true);
    expect(m?.test("KI-Entwickler (w/m/d)")).toBe(true);
    expect(m?.test("Senior KI–Entwickler")).toBe(true);
    expect(m?.test("KIEntwickler")).toBe(false);
  });

  it("escapes regex characters and handles non-ASCII boundaries", () => {
    expect(compileTermMatcher(["C++"])?.test("Senior C++ Developer")).toBe(true);
    expect(compileTermMatcher([".NET"])?.test("Senior .NET Developer")).toBe(true);
    expect(compileTermMatcher(["Entwickler"])?.test("Softwareentwickler")).toBe(false);
    expect(compileTermMatcher(["Ingenieur"])?.test("Ünteringenieur")).toBe(false);
  });
});

describe("createTitlePrefilter", () => {
  it("keeps titles that match a keyword of any search.yaml group", () => {
    const f = filter();
    expect(f.decide("Machine Learning Engineer", "Acme")).toEqual({ keep: true, reason: "keyword" });
    expect(f.decide("KI-Entwickler (w/m/d)", "Acme")).toEqual({ keep: true, reason: "keyword" });
    expect(f.decide("Forward Deployed Engineer, EMEA", "Acme")).toEqual({ keep: true, reason: "keyword" });
    expect(f.decide("Account Executive", "Acme")).toEqual({ keep: false, reason: "no_match" });
  });

  it("keeps every posting of a watched company (name match is case-insensitive)", () => {
    const f = filter({ exclude_terms: ["Intern"] }, ["acme  "]);
    expect(f.decide("Account Executive", "ACME")).toEqual({ keep: true, reason: "watched" });
    expect(f.decide("Marketing Intern", "Acme")).toEqual({ keep: true, reason: "watched" });
    expect(f.decide("Account Executive", "Other")).toEqual({ keep: false, reason: "no_match" });
  });

  it("compares company names by the push step's key: legal form and spelling do not matter", () => {
    const f = filter({}, ["Anthropic PBC", "Acme GmbH"]);
    expect(f.decide("Account Executive", "Anthropic")).toEqual({ keep: true, reason: "watched" });
    expect(f.decide("Account Executive", "acme")).toEqual({ keep: true, reason: "watched" });
    expect(f.decide("Account Executive", "Acme AI")).toEqual({ keep: false, reason: "no_match" });
  });

  it("never treats a name with an empty key as watched", () => {
    // a name without Latin letters resolves to an empty key; it must not watch every board whose name does too
    const f = filter({}, ["日本電気", ""]);
    expect(f.decide("Account Executive", "東京工業")).toEqual({ keep: false, reason: "no_match" });
    expect(f.fingerprint("東京工業")).toBe(filter({}, []).fingerprint("東京工業"));
  });

  it("include_terms keep extra titles; exclude_terms drop even keyword matches", () => {
    const f = filter({ include_terms: ["Data Scientist"], exclude_terms: ["Intern", "Werkstudent"] });
    expect(f.decide("Senior Data Scientist", "Acme")).toEqual({ keep: true, reason: "include_term" });
    expect(f.decide("Machine Learning Engineer Intern", "Acme")).toEqual({ keep: false, reason: "excluded" });
    expect(f.decide("AI Engineer (Werkstudent)", "Acme")).toEqual({ keep: false, reason: "excluded" });
    expect(f.decide("International AI Engineer", "Acme")).toEqual({ keep: true, reason: "keyword" });
  });

  it("keeps everything when disabled", () => {
    const f = filter({ enabled: false, exclude_terms: ["Intern"] });
    expect(f.decide("Marketing Intern", "Acme")).toEqual({ keep: true, reason: "disabled" });
  });

  it("fingerprints every input that changes what is kept", () => {
    const base = filter().fingerprint("Acme");
    expect(filter().fingerprint("Acme")).toBe(base);
    expect(filter({ enabled: false }).fingerprint("Acme")).not.toBe(base);
    expect(filter({ include_terms: ["x"] }).fingerprint("Acme")).not.toBe(base);
    expect(filter({ exclude_terms: ["x"] }).fingerprint("Acme")).not.toBe(base);
    expect(filter({}, ["Acme"]).fingerprint("Acme")).not.toBe(base);
    expect(filter({}, ["Acme"]).fingerprint("Other")).toBe(base);
    const moreKeywords = createTitlePrefilter({ settings: SETTINGS, keywordGroups: { ...KEYWORDS, extra: ["Data Engineer"] }, watchedCompanies: [], pipeline: PIPELINE });
    expect(moreKeywords.fingerprint("Acme")).not.toBe(base);
  });

  it("changes a board's fingerprint only when whether it is watched changes", () => {
    // "Anthropic PBC" in the list and a board named "Anthropic": the board turns watched, so it is read again
    expect(filter({}, ["Anthropic PBC"]).fingerprint("Anthropic")).not.toBe(filter({}, []).fingerprint("Anthropic"));
    // a spelling change of the list that leaves the board watched keeps the stored validator
    expect(filter({}, ["Anthropic PBC"]).fingerprint("Anthropic")).toBe(filter({}, ["anthropic"]).fingerprint("Anthropic"));
    // another company joining the list does not touch this board
    expect(filter({}, ["Anthropic", "Acme"]).fingerprint("Other")).toBe(filter({}, ["Anthropic"]).fingerprint("Other"));
  });
});

describe("shipped title_prefilter defaults (sources.yaml)", () => {
  const channels = configRegistry.channels.schema.parse(shippedYaml("sources.yaml"));
  const search = configRegistry.search.schema.parse(shippedYaml("search.yaml"));

  for (const id of ["greenhouse", "lever"] as const) {
    describe(id, () => {
      const f = createTitlePrefilter({
        settings: channels.sources[id].title_prefilter,
        keywordGroups: search.keyword_groups,
        watchedCompanies: [],
        pipeline: PIPELINE,
      });
      const keeps = (title: string) => f.decide(title, "Acme").keep;

      it.each([
        "Lead Applied Scientist (Example)",
        "Staff ML Engineer",
        "Senior KI-Architekt (m/w/d)",
        "LLM Platform Lead",
        "Applied Scientist, Search",
        "Forward Deployed Strategist",
        "Machine Learning / Data Platform",
        "GenAI Product Manager",
      ])("keeps %s", (title) => expect(keeps(title)).toBe(true));

      it.each([
        "Working Student AI",
        "Werkstudent Machine Learning (m/w/d)",
        "AI Engineer Intern",
        "AI Research Internship",
        "Praktikum KI",
        "Praktikant ML",
      ])("drops %s", (title) => expect(keeps(title)).toBe(false));

      it.each(["Thai Engineer", "Account Executive", "Maintenance Technician", "Email Marketing Manager", "International Payroll Specialist"])(
        "does not match %s through a substring",
        (title) => expect(keeps(title)).toBe(false),
      );
    });
  }
});

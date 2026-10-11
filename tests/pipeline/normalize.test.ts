// @vitest-environment node
import { describe, expect, it } from "vitest";

import { inferSeniority } from "@/lib/domain/seniority";
import { cityKeys, normalizeDraftLocations, normalizeLocation, slugify } from "@/lib/pipeline/geography";
import { normalizeDraft, normalizeTitle } from "@/lib/pipeline/normalize";
import { cleanTitle, decodeHtml, stripHtml } from "@/lib/pipeline/sanitize";
import { extractSkills } from "@/lib/pipeline/skills";

import { draft, shippedPipeline } from "./helpers";

const config = shippedPipeline();

describe("title normalization", () => {
  it.each([
    ["Applied AI Engineer (m/w/d)", "applied ai engineer"],
    ["Applied AI Engineer (f/m/x)", "applied ai engineer"],
    ["Applied AI Engineer m/f/d", "applied ai engineer"],
    ["Applied AI Engineer (all genders)", "applied ai engineer"],
    ["  Applied   AI-Engineer  ", "applied ai engineer"],
    ["KI-Entwickler:in", "ki entwickler"],
    ["KI-Entwickler*in (m/w/d)", "ki entwickler"],
    ["Datenwissenschaftler/in", "datenwissenschaftler"],
    ["Größe & Übung Engineer", "grosse and ubung engineer"],
    ["C++ Engineer", "c++ engineer"],
    ["CI/CD Engineer", "ci cd engineer"],
  ])("%s -> %s", (title, expected) => {
    expect(normalizeTitle(title)).toBe(expected);
  });
});

describe("locations", () => {
  it("canonicalises city spellings so sources agree", () => {
    expect(normalizeLocation("Munich, Bavaria, Germany", config.market)).toMatchObject({ city: "München", countryCode: "DE" });
    expect(normalizeLocation("München", config.market)).toMatchObject({ city: "München", countryCode: "DE" });
    expect(normalizeLocation("Cologne", config.market)).toMatchObject({ city: "Köln", countryCode: "DE" });
    expect(normalizeLocation("Berlin, Berlin, Germany", config.market)).toMatchObject({ city: "Berlin", countryCode: "DE" });
  });

  it("does not match European cities in non-European places; the stated country is kept", () => {
    expect(normalizeLocation("Dublin, CA", config.market)).toMatchObject({ city: null, countryCode: "US" });
    expect(normalizeLocation("Rome, United States", config.market)).toMatchObject({ city: null, countryCode: "US" });
  });

  it("reads a German city before 'Germany' even when it is not in the table", () => {
    expect(normalizeLocation("Gütersloh, Germany", config.market)).toMatchObject({ city: "Gütersloh", countryCode: "DE" });
    expect(normalizeLocation("Remote, Germany", config.market)).toMatchObject({ city: null, countryCode: "DE" });
  });

  it("completes a channel's location from its label without overriding what the channel states", () => {
    const [a, b, c] = normalizeDraftLocations([
      { label: "Munich", city: null, countryCode: null },
      { label: "Berlin", city: "Berlin", countryCode: "DE" },
      { label: "Springfield", city: "Springfield", countryCode: "US" },
    ], config.market);
    expect(a).toEqual({ label: "Munich", city: "München", countryCode: "DE", isPrimary: true });
    expect(b).toEqual({ label: "Berlin", city: "Berlin", countryCode: "DE", isPrimary: false });
    expect(c).toMatchObject({ city: "Springfield", countryCode: "US" });
  });

  it("drops duplicate locations and keys cities by slug", () => {
    const locations = normalizeDraftLocations([
      { label: "Munich", city: "Munich", countryCode: "DE" },
      { label: "München, Germany", city: "München", countryCode: "DE" },
    ], config.market);
    expect(locations).toHaveLength(1);
    expect([...cityKeys(locations)]).toEqual(["munchen"]);
    expect(slugify("Düsseldorf ß")).toBe("dusseldorf-ss");
  });
});

describe("seniority", () => {
  it.each([
    ["Senior Machine Learning Engineer", "senior"],
    ["Sr. Data Scientist", "senior"],
    ["Junior AI Engineer", "junior"],
    ["Berufseinsteiger Data Science", "junior"],
    ["Staff Engineer, ML Platform", "staff"],
    ["Principal Scientist", "principal"],
    ["Head of AI", "lead"],
    ["Lead Data Engineer", "lead"],
    ["Engineering Manager", "manager"],
    ["Praktikant KI", "intern"],
    ["AI Engineer", "unknown"],
  ])("%s -> %s", (title, expected) => {
    expect(inferSeniority(title)).toBe(expected);
  });

  it("never derives seniority from required years (C3)", () => {
    const job = normalizeDraft(draft({ title: "AI Engineer", description: "10+ years of experience required." }), config);
    expect(job.seniority).toBe("unknown");
  });

  it("falls back to the channel's hint", () => {
    expect(normalizeDraft(draft({ title: "AI Engineer", seniorityHint: "Entry level" }), config).seniority).toBe("junior");
    expect(normalizeDraft(draft({ title: "Senior AI Engineer", seniorityHint: "Entry level" }), config).seniority).toBe("senior");
  });
});

describe("sanitize", () => {
  it("decodes entities and strips HTML", () => {
    expect(decodeHtml("R&amp;D &lt;3 &#252;ber &#x41; &unknown; &#99999999;")).toBe("R&D <3 über A &unknown; &#99999999;");
    expect(stripHtml("<p>Hello&nbsp;<b>world</b></p><ul><li>One</li><li>Two</li></ul><br>Done")).toBe("Hello world\n\n- One\n- Two\n\nDone");
    expect(cleanTitle("<b>AI</b>\n Engineer ")).toBe("AI Engineer");
  });
});

describe("skills", () => {
  it("lists skills from the config patterns", () => {
    expect(extractSkills("Python, PyTorch and k8s; LLMs via Hugging Face. Retrieval-augmented generation.", config)).toEqual([
      "Python",
      "PyTorch",
      "Kubernetes",
      "LLMs",
      "Hugging Face",
      "RAG",
    ]);
    expect(extractSkills("Cooking", config)).toEqual([]);
  });
});

describe("normalizeDraft", () => {
  it("assembles every field and leaves unstated ones unknown", () => {
    const job = normalizeDraft(
      draft({
        title: "<b>Senior  AI Engineer</b> (m/w/d)",
        description:
          "<p>Fließende Deutschkenntnisse erforderlich.</p><p>Gehalt: 85.000 - 105.000 € pro Jahr. Unbefristete Festanstellung. Python und PyTorch.</p>",
        locations: [{ label: "Munich", city: "Munich", countryCode: "DE" }],
        postedAt: new Date("2026-10-01T00:00:00Z"),
      }),
      config,
    );
    expect(job).toMatchObject({
      title: "Senior AI Engineer (m/w/d)",
      titleNorm: "senior ai engineer",
      companyName: "Northwind Labs GmbH",
      seniority: "senior",
      contract: "permanent",
      isAgency: false,
      germanLevelRequired: "C1",
      skills: ["Python", "PyTorch"],
      postedAt: new Date("2026-10-01T00:00:00Z"),
      workplace: "hybrid",
    });
    expect(job.locations).toEqual([{ label: "Munich", city: "München", countryCode: "DE", isPrimary: true }]);
    expect(job.salary).toMatchObject({ origin: "description", eurPerYear: { min: 85000, max: 105000 } });
    expect(job.description).toBe("Fließende Deutschkenntnisse erforderlich.\n\nGehalt: 85.000 - 105.000 € pro Jahr. Unbefristete Festanstellung. Python und PyTorch.");
    expect(job.simhash).toBeNull(); // too short to hash
  });

  it("states unknown where the posting says nothing", () => {
    const job = normalizeDraft(draft({ title: "AI Engineer", description: "Build things." }), config);
    expect(job).toMatchObject({ seniority: "unknown", contract: "unknown", germanLevelRequired: "unknown", language: "unknown", salary: null, postedAt: null });
  });
});

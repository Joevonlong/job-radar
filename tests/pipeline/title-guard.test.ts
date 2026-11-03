// @vitest-environment node
import { describe, expect, it } from "vitest";

import { titleGuardSchema } from "@/lib/config/schemas/pipeline";
import type { JobLocation } from "@/lib/domain/types";
import type { Market } from "@/lib/market/types";
import { normalizeTitle } from "@/lib/pipeline/normalize";
import { classifyTitles, compileTitleGuard, type TitleRelation } from "@/lib/pipeline/title-guard";

import { editedPack, fixtureMarket } from "./helpers";

type Where = readonly (readonly [city: string | null, country: string | null])[];

const DE: Where = [["Berlin", "DE"]];
const guard = titleGuardSchema.parse({});

const side = (title: string, where: Where) => ({
  title,
  titleNorm: normalizeTitle(title),
  locations: where.map(([city, countryCode]): JobLocation => ({ label: city ?? countryCode ?? "", city, countryCode, isPrimary: true })),
});

function relation(a: string, b: string, options: { a?: Where; b?: Where; market?: Market; guard?: typeof guard } = {}): TitleRelation {
  const compiled = compileTitleGuard(options.guard ?? guard, options.market ?? fixtureMarket());
  return classifyTitles(side(a, options.a ?? DE), side(b, options.b ?? DE), compiled);
}

describe("title relation", () => {
  it.each([
    ["ML Engineer (m/w/d)", "ML Engineer"],
    ["Softwareentwickler:in", "Softwareentwickler"],
    ["(Senior) HR Tech Business Analyst", "Senior HR Tech Business Analyst"],
  ])("same: %s / %s", (a, b) => {
    expect(relation(a, b)).toBe("same");
    expect(relation(b, a)).toBe("same");
  });

  it.each([
    ["Data Scientist in Nürnberg", "Data Scientist"],
    ["Data Scientist in Nürnberg (m/w/d)", "Data Scientist"],
    ["Entwickler (m/w/div)", "Entwickler"],
    ["Entwickler (w/m/divers)", "Entwickler"],
    ["Entwickler - Bristol (m/w/div)", "Entwickler"],
    ["AI Research Engineer - Bristol", "AI Research Engineer"],
    ["Sr. Applied AI Engineer", "Senior Applied AI Engineer"],
    ["Engineering Manager, ML", "ML Engineering Manager"],
    ["Senior Engineer (Remote)", "Senior Engineer"],
    ["Remote Senior Engineer", "Senior Engineer - Hybrid"],
    ["Remote Sr. Engineer", "Senior Engineer"],
    ["Data Scientist - Germany", "Data Scientist"],
    ["Engineer - Berlin - Remote", "Engineer"],
  ])("compatible: %s / %s", (a, b) => {
    expect(relation(a, b)).toBe("compatible");
    expect(relation(b, a)).toBe("compatible");
  });

  it("reads US as a country both sides are in", () => {
    const us: Where = [["Austin", "US"]];
    expect(relation("Engineer - US", "Engineer", { a: us, b: us })).toBe("compatible");
  });

  it("takes a city from the posting's own locations when the table does not know it", () => {
    expect(relation("Engineer - Kleinkleckersdorf", "Engineer", { a: [["Kleinkleckersdorf", "DE"]] })).toBe("compatible");
    expect(relation("Engineer - Kleinkleckersdorf", "Engineer")).toBe("different");
  });

  describe.each(guard.work_mode_words)("work mode word %s", (word) => {
    it.each([
      [`Data Engineer (${word})`],
      [`Data Engineer - ${word}`],
    ])("%s", (title) => {
      expect(relation(title, "Data Engineer")).toBe("compatible");
    });
  });

  it.each([
    ["Senior Product Engineer", "Staff Product Engineer"],
    ["FDE", "Sr. FDE"],
    ["Engineering Manager", "ML Engineer Manager"],
    ["Engineer - EMEA", "Engineer"],
    ["Remote Internal Tools Engineer", "Internal Tools Engineer"],
    ["Sr. FDE - Retail", "Sr. FDE - Healthcare"],
    ["Hybrid Cloud Architect", "Cloud Architect"],
    ["Remote Sensing Engineer", "Sensing Engineer"],
    ["Data Scientist - Retail Berlin", "Data Scientist"],
    ["Engineer - Berlin & Munich", "Engineer"],
    ["Softwareentwickler", "Software Engineer"],
  ])("different: %s / %s", (a, b) => {
    expect(relation(a, b)).toBe("different");
    expect(relation(b, a)).toBe("different");
  });

  it("keeps a region and another country apart", () => {
    expect(relation("Senior AI Engineer - EU", "Senior AI Engineer - US", { a: [[null, "IE"]], b: [[null, "US"]] })).toBe("different");
  });

  it("strips a country only when both sides are located there", () => {
    expect(relation("Data Scientist - Germany", "Data Scientist", { b: [[null, "NL"]] })).toBe("different");
    expect(relation("Orbit Program - Germany", "Orbit Program - Netherlands", { a: [[null, "DE"]], b: [[null, "NL"]] })).toBe("different");
    const both: Where = [[null, "DE"], [null, "NL"]];
    expect(relation("Orbit Program - Germany", "Orbit Program - Netherlands", { a: both, b: both })).toBe("different");
  });

  it("lets a scope word win over the city and country tables", () => {
    const { market } = editedPack("generic", (pack) => {
      pack.geography.cities.orbit = ["Orbit", "DE"];
    });
    expect(relation("Engineer - Orbit", "Engineer", { market })).toBe("compatible");
    const scoped = titleGuardSchema.parse({ scope_words: ["orbit", "germany"] });
    expect(relation("Engineer - Orbit", "Engineer", { market, guard: scoped })).toBe("different");
    expect(relation("Engineer - Germany", "Engineer", { market, guard: scoped })).toBe("different");
  });

  it("leaves a title that is only a city", () => {
    expect(relation("Berlin", "Engineer")).toBe("different");
    expect(relation("Berlin", "Hamburg")).toBe("different");
  });

  it("reads two titles without letters or digits through their cores, never as the same key", () => {
    expect(relation("???", "!!!")).toBe("compatible");
  });

  it("maps a city spelling with brackets through the table", () => {
    const { market } = editedPack("generic", (pack) => {
      pack.geography.cities["frankfurt (main)"] = ["Frankfurt", "DE"];
    });
    expect(relation("Manager Data (m/w/d) in Frankfurt (Main)", "Manager Data (m/w/d)", { market })).toBe("compatible");
    expect(relation("Manager Data (m/w/d) in Frankfurt (Main)", "Manager Data (m/w/d) in Köln", { market })).toBe("compatible");
    expect(relation("Manager Data - Frankfurt (Main)", "Manager Data", { market })).toBe("compatible");
    expect(relation("Manager Data (m/w/d) in Berlin (Plattform)", "Manager Data (m/w/d)", { market })).toBe("different");
  });
});

describe("title relation, adversarial set", () => {
  it.each([
    // true hits, phrased unusually
    ["DATA ENGINEER (REMOTE)", "Data Engineer"],
    ["Data Engineer | Hamburg", "Data Engineer"],
    ["Data Engineer · Remote", "Data Engineer"],
    ["Data Engineer — Berlin", "Data Engineer"],
    ["[Remote] Data Engineer", "Data Engineer"],
    ["Berlin - Data Engineer", "Data Engineer"],
    ["Data Engineer (Berlin, München)", "Data Engineer"],
    ["Data Engineer (Berlin / Remote)", "Data Engineer"],
    ["Data Engineer for Hamburg", "Data Engineer for Berlin"],
    ["Data Engineer - 100% Remote Worldwide", "Data Engineer"],
    ["Data Engineer in Berlin - jobs-portal.com", "Data Engineer"],
    ["Datenanalyst für Köln", "Datenanalyst"],
    ["Entwickler bei München", "Entwickler"],
    ["Entwickler (m/w/d) im Homeoffice - Remote", "Entwickler im Homeoffice"],
    ["Berater (w/m/d) | Homeoffice", "Berater"],
    ["Berater - mobiles Arbeiten", "Berater"],
    ["Learning Engineer, Machine", "Machine Learning Engineer"],
  ])("compatible: %s / %s", (a, b) => {
    expect(relation(a, b)).toBe("compatible");
  });

  it.each([
    // near-misses: compounds, products and customers, duties, negations, questions
    ["Engineer - not remote", "Engineer"],
    ["Engineer (no remote)", "Engineer"],
    ["Remote work?", "Work"],
    ["Engineer (Hybrid Cloud)", "Engineer"],
    ["Remote Monitoring Engineer", "Monitoring Engineer"],
    ["On-site Support Engineer", "Support Engineer"],
    ["Engineer for Remote Devices", "Engineer"],
    ["Engineer for Data", "Engineer"],
    ["Engineer - Berlin Team", "Engineer"],
    ["Engineer at Hamburg Süd", "Engineer"],
    ["Engineer Berlin", "Engineer"],
    ["Engineer - Socket.io", "Engineer"],
    ["Engineer - Node.js", "Engineer"],
    ["Engineer - Germany only", "Engineer"],
    ["Engineer - Internal", "Engineer"],
    ["Senior Engineer", "Engineer"],
    ["Interim Engineer", "Engineer"],
    ["Consultant bei Berlin Recycling", "Consultant"],
    ["Entwickler für Hamburger Hafen", "Entwickler"],
    ["Homeoffice-Betreuer", "Betreuer"],
    ["Betreuer Homeoffice-Geräte", "Betreuer"],
    ["Entwickler - kein Homeoffice", "Entwickler"],
    ["Entwickler (nicht remote)", "Entwickler"],
    ["Mobiles Arbeiten Berater", "Berater"],
    ["Praktikant Entwicklung", "Entwicklung"],
    ["Werkstudent Vertrieb", "Vertrieb"],
    ["Leiter Vertrieb", "Vertrieb"],
    ["Vertriebsmitarbeiter Region: Süd-Deutschland", "Vertriebsmitarbeiter"],
    ["Architekt (Berlin Recycling)", "Architekt"],
  ])("different: %s / %s", (a, b) => {
    expect(relation(a, b)).toBe("different");
  });
});

import { describe, expect, it } from "vitest";

import { companyMatchNames, legalSuffixes } from "@/lib/writer/company-names";
import { mentionedCompanies, staleCompanies } from "@/lib/writer/similar";

const SUFFIXES = ["gmbh", "inc", "ag", "kg", "co"];

describe("companyMatchNames", () => {
  it("is the stored name, plus the name without its legal form when that reads differently", () => {
    expect(companyMatchNames("Acme GmbH", SUFFIXES)).toEqual(["Acme GmbH", "acme"]);
    expect(companyMatchNames("Acme Inc.", SUFFIXES)).toEqual(["Acme Inc.", "acme"]);
    expect(companyMatchNames("Acme", SUFFIXES)).toEqual(["Acme"]);
    expect(companyMatchNames("  Acme   GmbH ", SUFFIXES)).toEqual(["Acme GmbH", "acme"]);
  });

  it("uses the pipeline's rule: only trailing legal forms go, and a name made of one keeps it", () => {
    expect(companyMatchNames("GmbH Acme", SUFFIXES)).toEqual(["GmbH Acme"]);
    expect(companyMatchNames("Inc", SUFFIXES)).toEqual(["Inc"]);
    expect(companyMatchNames("Müller & Co. KG", SUFFIXES)).toEqual(["Müller & Co. KG", "muller"]);
  });

  it("is the stored name only without a suffix list", () => {
    expect(companyMatchNames("Acme GmbH", [])).toEqual(["Acme GmbH"]);
  });

  it("makes 'I love Acme' name 'Acme GmbH' and 'Acme Inc.', and not an unrelated company", () => {
    const stored = ["Acme GmbH", "Acme Inc.", "Initech AG"].map((company) => ({ company, names: companyMatchNames(company, SUFFIXES) }));
    expect(mentionedCompanies("I love Acme", stored)).toEqual(["Acme GmbH", "Acme Inc."]);
    expect(mentionedCompanies("I love Initech", stored)).toEqual(["Initech AG"]);
    expect(mentionedCompanies("I love Globex", stored)).toEqual([]);
    // the job's own company is Acme under another legal form: nothing is stale
    expect(staleCompanies("I love Acme", stored.slice(0, 1), companyMatchNames("Acme Inc.", SUFFIXES))).toEqual([]);
  });
});

describe("legalSuffixes", () => {
  it("is the pipeline's list (or empty when it cannot be read), as plain strings", () => {
    const list = legalSuffixes();
    expect(Array.isArray(list)).toBe(true);
    expect(list.every((entry) => typeof entry === "string")).toBe(true);
  });
});

// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { PipelineConfig } from "@/lib/config";
import { MAX_FILTER_VALUE_CHARS } from "@/lib/jobs/constants";
import { buildCompanyMatchIndex, canonicalCompanyNames, companyFilterKeys, matchCompanyIds, matchCompanyIdsFromIndex, resolveCompanyName, type CompanyMatchRow } from "@/lib/pipeline/company";

import { pipelineWith } from "./helpers";

const withCompany = (aliases: Record<string, string[]>): PipelineConfig =>
  pipelineWith((raw) => {
    const company = raw.company as { aliases: Record<string, string[]>; legal_suffixes: string[] };
    company.aliases = aliases;
    company.legal_suffixes = ["gmbh", "ag", "se", "inc"];
  });

const plain = withCompany({});
const keys = (entry: string, config: PipelineConfig = plain) => [...companyFilterKeys(entry, config)].sort();

/** A company as the pipeline stores it from a posting's company name. */
function stored(id: number, rawName: string, config: PipelineConfig = plain): CompanyMatchRow {
  const resolved = resolveCompanyName(rawName, config);
  return { id, name: resolved.name, nameNorm: resolved.nameNorm, aliases: resolved.aliases };
}

describe("companyFilterKeys", () => {
  it("folds case, accents and legal forms", () => {
    expect(keys("ZALANDO SE")).toEqual(["zalando"]);
    expect(keys("zalando")).toEqual(["zalando"]);
    expect(keys("Société Générale")).toEqual(["societe-generale"]);
  });

  it("holds the own key and the alias target's key", () => {
    const config = withCompany({ Newbrand: ["Oldbrand"] });
    expect(keys("Oldbrand GmbH", config)).toEqual(["newbrand", "oldbrand"]);
    expect(keys("Newbrand", config)).toEqual(["newbrand"]);
  });

  it("an alias added later still yields the key the old rows were stored under", () => {
    const before = stored(1, "Oldbrand GmbH");
    const after = withCompany({ Newbrand: ["Oldbrand"] });
    expect(keys(before.name, after)).toContain(before.nameNorm);
  });

  it("drops an empty key", () => {
    expect(keys("!!!")).toEqual([]);
  });
});

describe("matchCompanyIds", () => {
  const rows = [stored(1, "SAP SE"), stored(2, "SAP Fioneer GmbH"), stored(3, "Zalando SE"), stored(4, "N26")];

  it("matches the key, case and legal form ignored, never a substring", () => {
    expect(matchCompanyIds(rows, ["SAP"], plain)).toEqual([1]);
    expect(matchCompanyIds(rows, ["sap se"], plain)).toEqual([1]);
    expect(matchCompanyIds(rows, ["Fioneer"], plain)).toEqual([]);
    expect(matchCompanyIds(rows, ["Zal"], plain)).toEqual([]);
  });

  it("several names are an OR; nothing picked is nothing matched", () => {
    expect(matchCompanyIds(rows, ["Zalando", "N26"], plain)).toEqual([3, 4]);
    expect(matchCompanyIds(rows, [], plain)).toEqual([]);
    expect(matchCompanyIds(rows, ["Nobody"], plain)).toEqual([]);
  });

  it("a stored alias (raw spelling) matches once normalized", () => {
    const config = withCompany({ Newbrand: ["Oldbrand GmbH"] });
    const row = stored(5, "Oldbrand GmbH", config);
    expect(row).toMatchObject({ name: "Newbrand", aliases: ["Oldbrand GmbH"] });
    // without the alias in the config any more, the stored alias still finds the row
    expect(matchCompanyIds([row], ["Oldbrand"], plain)).toEqual([5]);
    expect(matchCompanyIds([row], ["Newbrand"], plain)).toEqual([5]);
  });

  it("the display name of a row always finds the row, even when its key came from another config", () => {
    // a key no current rule gives this name (an older normalization, a rename)
    const row: CompanyMatchRow = { id: 6, name: "Initech", nameNorm: "initech-legacy", aliases: [] };
    expect(matchCompanyIds([row], [row.name], plain)).toEqual([6]);
    expect(matchCompanyIds([row], ["INITECH"], plain)).toEqual([6]);
  });

  it("two rows of one company (not merged) are both picked", () => {
    const config = withCompany({ Newbrand: ["Oldbrand"] });
    const old = stored(7, "Oldbrand");
    const fresh = stored(8, "Oldbrand", config);
    expect(fresh.name).toBe("Newbrand");
    expect(matchCompanyIds([old, fresh], ["Oldbrand"], config)).toEqual([7, 8]);
  });

  it("index matching agrees with the wrapper, keeping unique ids in row order across names and aliases", () => {
    const config = withCompany({ Newbrand: ["Oldbrand"] });
    const companies = [stored(7, "Oldbrand"), stored(2, "Oldbrand", config), stored(9, "SAP SE"), { id: 3, name: "研究所", nameNorm: "legacy", aliases: [] }];
    const index = buildCompanyMatchIndex(companies, config);
    for (const names of [[], ["Nobody"], ["Fioneer"], ["研究所"], ["SAP", "Oldbrand", "NEWBRAND", "sap se", "研究所"]]) {
      expect(matchCompanyIdsFromIndex(index, names)).toEqual(matchCompanyIds(companies, names, config));
    }
    expect(matchCompanyIdsFromIndex(index, ["研究所"])).toEqual([3]);
    expect(matchCompanyIdsFromIndex(index, ["SAP", "Oldbrand", "NEWBRAND", "sap se", "研究所"])).toEqual([7, 2, 9, 3]);
  });
});

describe("canonicalCompanyNames", () => {
  const rows = [stored(1, "Zalando SE"), stored(2, "Acme"), stored(3, "ACME GmbH")];

  it("writes a name that picks one company as its display name, and drops the duplicate that leaves", () => {
    expect(canonicalCompanyNames(buildCompanyMatchIndex(rows, plain), ["zalando"])).toEqual(["Zalando SE"]);
    expect(canonicalCompanyNames(buildCompanyMatchIndex(rows, plain), ["zalando", "Zalando SE"])).toEqual(["Zalando SE"]);
    expect(canonicalCompanyNames(buildCompanyMatchIndex(rows, plain), ["Zalando SE"])).toEqual(["Zalando SE"]);
  });

  it("keeps a name that picks several companies or none as written", () => {
    expect(canonicalCompanyNames(buildCompanyMatchIndex(rows, plain), ["acme"])).toEqual(["acme"]);
    expect(canonicalCompanyNames(buildCompanyMatchIndex(rows, plain), ["Nobody"])).toEqual(["Nobody"]);
  });

  it("never writes a display name the URL cannot carry", () => {
    const long = `${"Long ".repeat(MAX_FILTER_VALUE_CHARS / 5)}Name`;
    const row: CompanyMatchRow = { id: 9, name: long, nameNorm: "long-short", aliases: ["Long Short"] };
    expect(canonicalCompanyNames(buildCompanyMatchIndex([row], plain), ["Long Short"])).toEqual(["Long Short"]);
  });

  it.each([" Acme ", ""])("keeps the input when the stored display name is %j", (name) => {
    const row: CompanyMatchRow = { id: 9, name, nameNorm: "short", aliases: [] };
    expect(canonicalCompanyNames(buildCompanyMatchIndex([row], plain), ["Short"])).toEqual(["Short"]);
  });

  it("keeps a unique alias when the display name would also pick another row", () => {
    const row: CompanyMatchRow = { id: 9, name: "Acme", nameNorm: "unique", aliases: [] };
    expect(canonicalCompanyNames(buildCompanyMatchIndex([...rows, row], plain), ["Unique"])).toEqual(["Unique"]);
  });
});

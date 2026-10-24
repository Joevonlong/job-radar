import { describe, expect, it } from "vitest";

import { buildBlacklistedCompanyKeys, buildWatchedCompanyKeys, isCompanyExcluded, isCompanyWatched, watchedEntryFor } from "@/lib/companies/marks";

import { pipelineWith } from "../pipeline/helpers";

const pipeline = pipelineWith((raw) => {
  raw.company = { ...(raw.company as object), legal_suffixes: ["gmbh"], aliases: { Acme: ["Legacy GmbH"] } };
});
const suffixes = pipeline.company.legal_suffixes;
const row = { name: "Acme", nameNorm: "acme", aliases: ["Oldbrand GmbH"] };

describe("company marks", () => {
  it("watches by DB flag or the resolved name key, exactly as push does", () => {
    const keys = buildWatchedCompanyKeys(["Legacy GmbH"], pipeline);
    expect([...keys]).toEqual(["acme"]);
    expect(isCompanyWatched({ watched: true, nameNorm: "other" }, keys)).toBe(true);
    expect(isCompanyWatched({ watched: false, nameNorm: "acme" }, keys)).toBe(true);
    expect(isCompanyWatched({ watched: false, nameNorm: "legacy" }, keys)).toBe(false);
    expect(isCompanyWatched({ watched: false, nameNorm: "other" }, keys)).toBe(false);
  });

  it("excludes by DB flag, display name or normalized persisted alias", () => {
    expect(isCompanyExcluded({ ...row, blacklisted: true }, new Set(), suffixes)).toBe(true);
    for (const name of ["ACME GmbH", "Oldbrand", "Oldbrand GmbH", "Legacy GmbH"]) {
      expect(isCompanyExcluded({ ...row, blacklisted: false }, buildBlacklistedCompanyKeys([name], pipeline), suffixes)).toBe(true);
    }
    expect(isCompanyExcluded({ ...row, blacklisted: false }, buildBlacklistedCompanyKeys(["Other"], pipeline), suffixes)).toBe(false);
  });

  it("keeps both raw and resolved exclusion keys, without checking a stale stored key", () => {
    const keys = buildBlacklistedCompanyKeys(["Legacy GmbH"], pipeline);
    expect([...keys].sort()).toEqual(["acme", "legacy"]);
    expect(isCompanyExcluded({ name: "Other", nameNorm: "legacy", aliases: [], blacklisted: false }, keys, suffixes)).toBe(false);
  });

  it("finds the original watch-list spelling whose resolved key watches the row, as push does", () => {
    expect(watchedEntryFor(row, ["Other", "Acme GmbH"], pipeline)).toBe("Acme GmbH");
    expect(watchedEntryFor(row, ["Legacy GmbH"], pipeline)).toBe("Legacy GmbH");
    // a persisted alias does not make push watch the row, so it gives no entry to remove either
    expect(isCompanyWatched({ watched: false, nameNorm: row.nameNorm }, buildWatchedCompanyKeys(["Oldbrand"], pipeline))).toBe(false);
    expect(watchedEntryFor(row, ["Oldbrand"], pipeline)).toBeNull();
    expect(watchedEntryFor(row, ["Other"], pipeline)).toBeNull();
    expect(watchedEntryFor(row, [], pipeline)).toBeNull();
  });
});

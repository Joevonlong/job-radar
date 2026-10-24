import { describe, expect, it, vi } from "vitest";

import { loadCompanyOverview, type CompanyOverviewSettings } from "@/lib/companies/overview";
import type { CompanyOverviewRow } from "@/lib/db";
import { MAX_COMPANY_NAME_CHARS } from "@/lib/interests/service";
import { MAX_FILTER_VALUE_CHARS } from "@/lib/jobs/constants";

import { pipelineWith } from "../pipeline/helpers";

const settings: CompanyOverviewSettings = {
  pageSize: 2,
  timezone: "UTC",
  pipeline: pipelineWith((raw) => {
    raw.company = { ...(raw.company as object), legal_suffixes: ["gmbh"], aliases: {} };
  }),
  watchedCompanies: ["Acme", "Acme GmbH"],
  excludedCompanies: ["Oldbrand GmbH", "No matching record"],
};

const row = (id: number, overrides: Partial<CompanyOverviewRow> = {}): CompanyOverviewRow => ({
  id, name: "Acme", nameNorm: "acme", aliases: [], watched: false, blacklisted: false,
  jobCount: 3, topRank: null, lastFirstSeenAt: new Date("2026-10-01T00:00:00Z"), ...overrides,
});

describe("company overview loader", () => {
  it("passes validated URL state and configured paging/timezone to the query, returning the clamped page", async () => {
    const list = vi.fn(async () => ({ rows: [row(1)], total: 5, page: 3, pageCount: 3 }));
    const result = await loadCompanyOverview(Promise.resolve({ q: " Acme ", sort: "score", dir: "asc", page: "999" }), { loadSettings: () => settings, list });
    expect(list).toHaveBeenCalledWith({ q: "Acme", sort: "score", dir: "asc", page: 999, pageSize: 2, timezone: "UTC" });
    expect(result).toMatchObject({ total: 5, page: 3, pageCount: 3, pageSize: 2, params: { q: "Acme", sort: "score", dir: "asc", page: 3 }, excludedCount: 2 });
  });

  it("decorates rows without changing push/filter semantics, and keeps unusable company links null", async () => {
    const input = [
      row(1),
      row(2, { name: "Flag only", nameNorm: "flag-only", watched: true }),
      row(3, { watched: true, aliases: ["Oldbrand GmbH"] }),
      row(4, { name: "x".repeat(MAX_FILTER_VALUE_CHARS + 1), nameNorm: "long", blacklisted: true }),
      row(5, { name: "Other", nameNorm: "other" }),
    ];
    const result = await loadCompanyOverview({}, { loadSettings: () => settings, list: async () => ({ rows: input, total: 5, page: 1, pageCount: 3 }) });
    expect(result.rows.map(({ watched, watchedEntries, watchedByFlagOnly, companyFlagWatched, watchable, excluded, href }) => ({ watched, watchedEntries, watchedByFlagOnly, companyFlagWatched, watchable, excluded, href }))).toEqual([
      { watched: true, watchedEntries: ["Acme", "Acme GmbH"], watchedByFlagOnly: false, companyFlagWatched: false, watchable: true, excluded: false, href: "/jobs?company=Acme" },
      { watched: true, watchedEntries: [], watchedByFlagOnly: true, companyFlagWatched: true, watchable: true, excluded: false, href: "/jobs?company=Flag+only" },
      { watched: true, watchedEntries: ["Acme", "Acme GmbH"], watchedByFlagOnly: false, companyFlagWatched: true, watchable: true, excluded: true, href: "/jobs?company=Acme" },
      { watched: false, watchedEntries: [], watchedByFlagOnly: false, companyFlagWatched: false, watchable: false, excluded: true, href: null },
      { watched: false, watchedEntries: [], watchedByFlagOnly: false, companyFlagWatched: false, watchable: true, excluded: false, href: "/jobs?company=Other" },
    ]);
    expect(input[0]!.watched).toBe(false);
  });

  it("prevents watching a stale stored key after a pipeline alias is added", async () => {
    const stored = row(1, { name: "Legacy GmbH", nameNorm: "legacy" });
    const pipeline = pipelineWith((raw) => {
      raw.company = { ...(raw.company as object), legal_suffixes: ["gmbh"], aliases: { Acme: ["Legacy GmbH"] } };
    });
    const list = async () => ({ rows: [stored], total: 1, page: 1, pageCount: 1 });
    expect((await loadCompanyOverview({}, { loadSettings: () => settings, list })).rows[0]).toMatchObject({ watchable: true });
    expect((await loadCompanyOverview({}, { loadSettings: () => ({ ...settings, pipeline }), list })).rows[0]).toMatchObject({ watched: false, watchedEntries: [], watchable: false });
  });

  it("permits names at the watch-list limit and rejects longer names even with a current stored key", async () => {
    const names = ["x".repeat(MAX_COMPANY_NAME_CHARS), "x".repeat(MAX_COMPANY_NAME_CHARS + 1)];
    const result = await loadCompanyOverview({}, {
      loadSettings: () => settings,
      list: async () => ({ rows: names.map((name, index) => row(index + 1, { name, nameNorm: name })), total: 2, page: 1, pageCount: 1 }),
    });
    expect(result.rows.map(({ watchable }) => watchable)).toEqual([true, false]);
  });
});

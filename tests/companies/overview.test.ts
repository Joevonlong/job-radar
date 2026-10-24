import { describe, expect, it, vi } from "vitest";

import { loadCompanyOverview, type CompanyOverviewSettings } from "@/lib/companies/overview";
import type { CompanyOverviewRow } from "@/lib/db";
import { MAX_FILTER_VALUE_CHARS } from "@/lib/jobs/constants";

import { pipelineWith } from "../pipeline/helpers";

const settings: CompanyOverviewSettings = {
  pageSize: 2,
  timezone: "UTC",
  pipeline: pipelineWith((raw) => {
    raw.company = { ...(raw.company as object), legal_suffixes: ["gmbh"], aliases: {} };
  }),
  watchedCompanies: ["Acme GmbH"],
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
    expect(result.rows.map(({ watched, watchedEntry, watchedByFlagOnly, excluded, href }) => ({ watched, watchedEntry, watchedByFlagOnly, excluded, href }))).toEqual([
      { watched: true, watchedEntry: "Acme GmbH", watchedByFlagOnly: false, excluded: false, href: "/jobs?company=Acme" },
      { watched: true, watchedEntry: null, watchedByFlagOnly: true, excluded: false, href: "/jobs?company=Flag+only" },
      { watched: true, watchedEntry: "Acme GmbH", watchedByFlagOnly: false, excluded: true, href: "/jobs?company=Acme" },
      { watched: false, watchedEntry: null, watchedByFlagOnly: false, excluded: true, href: null },
      { watched: false, watchedEntry: null, watchedByFlagOnly: false, excluded: false, href: "/jobs?company=Other" },
    ]);
    expect(input[0]!.watched).toBe(false);
  });
});

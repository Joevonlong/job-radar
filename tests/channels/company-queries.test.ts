// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildCompanyQueries, buildQueries, companyLabel, queryId, searchKind } from "@/lib/channels/query";
import { selectCompanyQueries, orderQueries } from "@/lib/channels/rotation";
import { watchedCompanyBoards } from "@/lib/companies/watched-boards";
import { loadPipeline } from "@/lib/market";
import { shippedSearch } from "./helpers";

const search = shippedSearch();
const cfg = { enabled: true, max_per_cycle: 2, min_interval_hours: 24, max_results: 17 };
const companies = watchedCompanyBoards(["Acme", "ACME GmbH", "Other", "Board"], [{ name: "Board", enabled: true }], loadPipeline());
const candidates = () => buildCompanyQueries({ ...search, watched_company_queries: cfg }, companies, 10);

describe("company queries", () => {
  it("deduplicates company keys, leaves boards out, and uses the first spelling", () => {
    expect(candidates()).toHaveLength(2);
    expect(candidates()[0]).toMatchObject({ company: { name: "Acme", key: "acme" }, keywords: ["Acme"], keywordGroup: "company:acme", location: null, remote: false, remoteScope: null, windowHours: 10, maxResults: 17 });
    expect(searchKind(candidates()[0]!)).toBe("company");
    expect(companyLabel(candidates()[0]!)).toBe("Acme");
    expect(buildCompanyQueries({ ...search, watched_company_queries: { ...cfg, enabled: false } }, companies, 10)).toEqual([]);
    expect(buildCompanyQueries(search, [], 10)).toEqual([]);
  });

  it("hashes only the company key, independent of name, window, or keyword settings", () => {
    const first = candidates()[0]!;
    expect(queryId({ ...first, company: { name: "Acme GmbH", key: "acme" }, keywords: ["unrelated"], location: "Elsewhere" })).toBe(first.id);
    expect(buildQueries(search, "manual").every((q) => q.company === null)).toBe(true);
    expect(searchKind(buildQueries(search, "manual")[0]!)).toBe("city");
    expect(searchKind(buildQueries(search, "manual").find((q) => q.remote)!)).toBe("remote");
  });

  it("preserves fixed legacy hashes byte for byte", () => {
    const base = { keywordGroup: "g", keywords: ["a", "b"], location: "Berlin", remote: false, remoteScope: null };
    expect(queryId(base)).toBe("dcc1e93228be9367");
    expect(queryId({ ...base, location: null, remote: true, remoteScope: "home_country" })).toBe("154cb704d851ad16");
  });
});

describe("company query selection", () => {
  const now = new Date("2026-10-30T12:00:00Z");
  const row = (channelId: string, index: number, hours: number) => ({ channelId, queryHash: candidates()[index]!.id, firstSeenAt: new Date(0), lastCoveredAt: null, lastTurnAt: new Date(now.getTime() - hours * 3_600_000) });
  const select = (rotation = true, history = [row("guest", 0, 2), row("unsupported", 1, 1)]) => selectCompanyQueries({ candidates: candidates(), history, eligible: ["session", "guest"], now, cfg, rotation });

  it("merges eligible history, so a member switch cannot bypass the interval", () => {
    expect(select().selected.map((q) => q.company?.name)).toEqual(["Other"]);
    expect(select().due).toBe(1);
    expect(select().turns.get(candidates()[0]!.id)).toEqual(row("guest", 0, 2).lastTurnAt);
  });

  it("uses wait order or list order, applies the cap, and merges with keyword turns", () => {
    const history = [row("guest", 0, 25), row("session", 1, 48)];
    expect(select(true, history).selected.map((q) => q.company?.name)).toEqual(["Other", "Acme"]);
    expect(select(false, history).selected.map((q) => q.company?.name)).toEqual(["Acme", "Other"]);
    const result = selectCompanyQueries({ candidates: candidates(), history, eligible: ["guest", "session"], now, cfg: { ...cfg, max_per_cycle: 1 }, rotation: true });
    expect(result.selected).toHaveLength(1);
    const keyword = buildQueries(search, "manual")[0]!;
    expect(orderQueries([keyword, ...result.selected], new Map([...result.turns, [keyword.id, now]]), true)[0]?.company?.name).toBe("Other");
    expect(selectCompanyQueries({ candidates: candidates(), history: [row("guest", 0, 24)], eligible: ["guest"], now, cfg, rotation: true }).due).toBe(2);
  });
});

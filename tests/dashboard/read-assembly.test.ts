// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queries = vi.hoisted(() => ({
  listTodayJobs: vi.fn(async () => [{ id: 7 }]),
  countTodayQuickViews: vi.fn(async () => ({ all: 3, high: 2, salary: 1, following: 1 })),
  countTodayJobs: vi.fn(async () => 2),
  getLatestCycleSummary: vi.fn(async () => ({ id: 4 })),
}));
vi.mock("@/lib/db", async (original) => ({ ...await original<object>(), ...queries }));
vi.mock("@/lib/interests/views", () => ({ loadSavedViews: vi.fn() }));
vi.mock("@/lib/jobs/cities", () => ({ loadCityGroups: vi.fn(async () => []) }));
vi.mock("@/lib/jobs/job-filters", async (original) => ({ ...await original<object>(), resolveViewCompanyIds: vi.fn(async () => [[3], [3]]) }));
vi.mock("@/lib/visa/filter", () => ({ visaFilterAvailable: async () => false }));
vi.mock("@/lib/ghost/filter", () => ({ ghostFilterAvailable: async () => true }));
vi.mock("@/lib/dashboard/german", () => ({ germanLevelsToHide: () => ["C1", "C2"] }));
vi.mock("@/lib/signals/floor", () => ({ loadHighValuePolicy: () => ({ amountHighValue: false, amountId: null, otherIds: ["cert"] }) }));
vi.mock("@/lib/config", () => ({ loadConfig: () => ({ push_min_score: 71, push_min_score_high_value: 53 }) }));

import { loadSavedViews } from "@/lib/interests/views";
import { getToday } from "@/lib/mcp/tools/get-today";
import { readContext } from "../mcp/read-fixtures";
import type { Db } from "@/lib/db";
import { loadTodayData } from "@/lib/dashboard/today-data";
import { detailChecks, detailCheckViews, breakdownViewInput, salaryContextInput, companyResearchInput } from "@/lib/jobs/detail-inputs";
import { blockDetail, BLOCK_NOW } from "../mcp/job-block-fixtures";

const now = BLOCK_NOW;
beforeEach(() => vi.mocked(loadSavedViews).mockReturnValue([{ id: "focused", name: "Focused", default: true, filters: { company: ["Acme"], minScore: 60, high: true, hideLang: true } }]));
afterEach(() => vi.clearAllMocks());

describe("page read assembly characterization", () => {
  it("keeps the selected saved view ahead of quick filters and counts tabs without current toggles", async () => {
    const value = await loadTodayData({} as Db, { view: "focused", filtered: true, hideLang: false, high: null, quick: "salary" }, { now, timezone: "UTC", languageEnabled: true });
    expect(queries.listTodayJobs).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ now, timezone: "UTC", cycle: { id: 4 }, includeFiltered: true, quick: null, hideGermanLevels: [], highValueOnly: true, quickLines: { qualifiedMinRank: 71, qualifiedMinRankWithSignals: 53 }, extra: expect.objectContaining({ companyIds: [3], minRank: 60 }), visa: false, ghost: true }));
    expect(queries.countTodayJobs).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ includeFiltered: false, hideGermanLevels: ["C1", "C2"], highValueOnly: true, extra: expect.objectContaining({ companyIds: [3], minRank: 60 }) }));
    expect(value).toMatchObject({ cards: [{ id: 7 }], quickCounts: { all: 3, high: 2, salary: 1, following: 1 }, viewCounts: [2], filtered: true, hideLang: false, high: true });
  });

  it("uses quick views only without a saved view and disables language hiding without a market language", async () => {
    await loadTodayData({} as Db, { view: "all", filtered: null, hideLang: true, high: false, quick: "following" }, { now, timezone: "UTC", languageEnabled: false });
    expect(queries.listTodayJobs).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ quick: "following", hideGermanLevels: [], highValueOnly: false, includeFiltered: false }));
  });

  it("preserves detail check results and quote-view inputs without translating them", () => {
    const job = blockDetail();
    const aliases = new Map<string, string>();
    const checks = detailChecks(job, { profileSkills: ["Python"], aliases, germanLabel: "B1", salaryFloor: null, currency: "EUR" });
    expect(checks.skillMatches).toEqual([{ name: "Python", have: true }, { name: "SQL", have: false }]);
    expect(checks.german).toMatchObject({ state: "gap", required: "B2" });
    expect(checks.floor.state).toBe("no_floor");
    const input = breakdownViewInput(job, { row: null, signalQuotes: ["data pipelines"], profileSkills: ["Python"], profileYears: 4, aliases, catalog: null, outputLang: "en" });
    expect(input).toEqual({ row: null, description: job.description, signalQuotes: ["data pipelines"], profileSkills: ["Python"], profileYears: 4, aliases, catalog: null, outputLang: "en" });
    expect(salaryContextInput(job, { currency: "EUR", salary: null, ai: null, locale: "en", now })).toEqual({ jobId: 7, figure: null, currency: "EUR", salary: null, ai: null, locale: "en", now });
    expect(companyResearchInput(7, { state: "error", problem: "unreadable" }, null, now)).toEqual({ jobId: 7, research: null, ai: null, now });
    expect(detailCheckViews(job, { visa: false, needsVisaSponsorship: false, ghost: false })).toEqual({ visaView: null, ghostView: null });
    expect(detailCheckViews(job, { visa: true, needsVisaSponsorship: true, ghost: true })).toMatchObject({ visaView: { state: "offered" }, ghostView: { state: "dismissed" } });
  });
});

describe("MCP saved view permissions", () => {
  it("omits the default view without profile permission and refuses an explicit saved view", async () => {
    queries.listTodayJobs.mockResolvedValueOnce([]);
    const result = await getToday(readContext(), {});
    expect(result.view).toBeNull();
    expect(loadSavedViews).not.toHaveBeenCalled();
    expect(queries.listTodayJobs).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ highValueOnly: false, extra: expect.not.objectContaining({ minRank: 60 }) }));
    await expect(getToday(readContext(), { view: "focused" })).rejects.toMatchObject({ category: "not_permitted", message: expect.stringContaining("profile:read") });
  });

  it.each([{}, { view: "focused" }])("uses the saved view with profile permission: %j", async (args) => {
    queries.listTodayJobs.mockResolvedValueOnce([]);
    const result = await getToday(readContext(["jobs:read", "profile:read"]), args);
    expect(result.view).toBe("focused");
    expect(queries.countTodayJobs).not.toHaveBeenCalled();
  });

  it("refuses the following view without tracking permission before any queries, and counts it only with that permission", async () => {
    await expect(getToday(readContext(["jobs:read"]), { quick: "following" })).rejects.toMatchObject({ category: "not_permitted", message: expect.stringContaining("tracking:read") });
    for (const query of Object.values(queries)) expect(query).not.toHaveBeenCalled();
    queries.listTodayJobs.mockResolvedValueOnce([]);
    expect((await getToday(readContext(["jobs:read"]), {})).quick_counts).toEqual({ all: 3, high: 2, salary: 1 });
    queries.listTodayJobs.mockResolvedValueOnce([]);
    expect((await getToday(readContext(), {})).quick_counts).toEqual({ all: 3, high: 2, salary: 1, following: 1 });
  });

  it.each([{}, { view: "private-status" }])("refuses application filters before any queries: %j", async (args) => {
    vi.mocked(loadSavedViews).mockReturnValue([{ id: "private-status", name: "Private status", default: true, filters: { app: ["interviewing"] } }]);
    await expect(getToday(readContext(["jobs:read", "profile:read"]), args)).rejects.toMatchObject({ category: "not_permitted", message: expect.stringContaining("tracking:read") });
    for (const query of Object.values(queries)) expect(query).not.toHaveBeenCalled();
    queries.listTodayJobs.mockResolvedValueOnce([]);
    expect((await getToday(readContext(["jobs:read", "profile:read", "tracking:read"]), args)).view).toBe("private-status");
    expect(queries.listTodayJobs).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ extra: expect.objectContaining({ applicationStatuses: ["interviewing"] }) }));
  });
});

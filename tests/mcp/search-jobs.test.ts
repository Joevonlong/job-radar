// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/queries/jobs", async (original) => ({ ...await original<typeof import("@/lib/db/queries/jobs")>(), listJobs: vi.fn() }));
vi.mock("@/lib/jobs/cities", () => ({ loadCityGroups: vi.fn() }));
vi.mock("@/lib/visa/filter", () => ({ visaFilterAvailable: vi.fn() }));
vi.mock("@/lib/ghost/filter", () => ({ ghostFilterAvailable: vi.fn() }));
vi.mock("@/lib/db/repos/traps", async (original) => ({ ...await original<typeof import("@/lib/db/repos/traps")>(), currentTrapScanJobIds: vi.fn() }));
import { PERMISSIONS, type Permission } from "@/lib/agent-access/permissions";
import { loadCityGroups } from "@/lib/jobs/cities";
import { buildSearchPlanLenient } from "@/lib/jobs/search";
import * as market from "@/lib/market";
import { jobsListFilters } from "@/lib/jobs/list-filters";
import { loadJobsSearchParams } from "@/lib/jobs/search-params";
import { visaFilterAvailable } from "@/lib/visa/filter";
import { ghostFilterAvailable } from "@/lib/ghost/filter";
import { currentTrapScanJobIds } from "@/lib/db/repos/traps";
import type { JobCard } from "@/lib/db/queries/types";
import { searchJobsOutputFor, toJobCardDto } from "@/lib/mcp/dto";
import { trapSettings } from "../traps/helpers";
import { BLOCK_NOW } from "./job-block-fixtures";
import { SearchTimeoutError, listJobs } from "@/lib/db/queries/jobs";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import type { McpContext } from "@/lib/mcp/context";
import { defaultContext } from "@/lib/mcp/server";
import { mcpTranslator } from "@/lib/mcp/text";
import { searchJobs, searchJobsInput, searchJobsParams, type SearchJobsArgs } from "@/lib/mcp/tools/search-jobs";
import type { Db } from "@/lib/db";

import { searchPlan } from "../fixtures/job-search";

const ctx: McpContext = { ...defaultContext({} as Db, mcpSchema.parse({ enabled: true })), searchPlan, now: () => BLOCK_NOW, text: mcpTranslator("en"), timezone: () => "UTC", log: vi.fn() };
const input = searchJobsInput({ text: mcpTranslator("en") });
beforeEach(() => {
  vi.mocked(loadCityGroups).mockReset().mockResolvedValue([]);
  vi.mocked(visaFilterAvailable).mockReset().mockResolvedValue(true);
  vi.mocked(ghostFilterAvailable).mockReset().mockResolvedValue(true);
  vi.mocked(currentTrapScanJobIds).mockReset().mockResolvedValue(new Set([7]));
  vi.mocked(listJobs).mockReset().mockResolvedValue({ jobs: [], total: 0, page: 1, pageSize: 20, pageCount: 1 });
});

describe("MCP search parameters", () => {
  it("accepts and uppercases bounded exact country codes and both search scopes", () => {
    expect(input.parse({ country: ["de", "Fr"], search_in: "all", sort: "relevance" })).toMatchObject({ country: ["DE", "FR"], search_in: "all", sort: "relevance" });
    for (const raw of [{ country: [] }, { country: ["DEU"] }, { country: Array(21).fill("DE") }, { search_in: "jd" }]) expect(input.safeParse(raw).success).toBe(false);
  });

  it("defaults query calls to relevance and summary, passing the shared plan and optional country/all scope", async () => {
    await searchJobs(ctx, input.parse({ query: "AI", country: ["de"], search_in: "all" }));
    expect(listJobs).toHaveBeenLastCalledWith(ctx.db, expect.objectContaining({ sort: "relevance", filters: expect.objectContaining({ search: searchPlan("AI"), countries: ["DE"], searchIn: "all", includeFiltered: null, scope: null, statuses: null }) }));
    await searchJobs(ctx, input.parse({ query: "AI" }));
    expect(listJobs).toHaveBeenLastCalledWith(ctx.db, expect.objectContaining({ sort: "relevance", filters: expect.objectContaining({ searchIn: null }) }));
    await searchJobs(ctx, input.parse({ query: "AI", sort: "rank" }));
    expect(listJobs).toHaveBeenLastCalledWith(ctx.db, expect.objectContaining({ sort: "rank" }));
    const output = await searchJobs(ctx, input.parse({}));
    expect(listJobs).toHaveBeenLastCalledWith(ctx.db, expect.objectContaining({ sort: "rank" }));
    expect(Object.keys(output).sort()).toEqual(["jobs", "notices", "returned", "total", "truncated"]);
  });

  it("keeps since / until as first-seen dates: it names no date, so the list query compares first seen", async () => {
    await searchJobs(ctx, input.parse({ since: "2026-10-01", until: "2026-10-15" }));
    const filters = vi.mocked(listJobs).mock.calls.at(-1)?.[1].filters;
    expect(filters).toMatchObject({ from: "2026-10-01", to: "2026-10-15" });
    expect(filters).toMatchObject({ dateField: "seen", within: null });
  });

  it("propagates search configuration errors instead of silently changing the matcher", async () => {
    const fail = () => { throw new Error("invalid config"); };
    await expect(searchJobs({ ...ctx, searchPlan: fail }, input.parse({ query: "AI" }))).rejects.toThrow("invalid config");
    expect(listJobs).not.toHaveBeenCalled();
  });
});

const traps = trapSettings();
const SUMMARY = "SENTINEL-summary";
const FILTER = "SENTINEL-filter-reason";
const NOTE = "SENTINEL-favorite-note";
const BONUS = 987.123;

function card(edit: Partial<JobCard> = {}): JobCard {
  return {
    id: 7, title: "Engineer", companyId: 1, companyName: "Fixture", locations: [], workplace: "hybrid", contract: "permanent",
    isAgency: false, germanLevelRequired: "none", status: "active", closedReason: null, linkCheck: null,
    postedAt: null, firstSeenAt: BLOCK_NOW, lastSeenAt: BLOCK_NOW, lastListedAt: null, relistedAt: null, relistCount: 0,
    salaryDisclosed: false, salary: null, skills: [], sources: [], applicationStatus: "applied",
    favorite: { createdAt: BLOCK_NOW, note: NOTE }, seen: true, signals: [],
    rank: { rankValue: 70, score: 70, signalBonus: BONUS, filterResult: "passed", filterReasons: [FILTER], stale: false },
    summary: { texts: { en: SUMMARY, zh: "摘要" }, outputLang: "en" }, ...edit,
  };
}

function cards(...jobs: JobCard[]): void {
  vi.mocked(listJobs).mockResolvedValue({ jobs, total: jobs.length, page: 1, pageSize: 20, pageCount: 1 });
}

function context(permissions: readonly Permission[]): McpContext {
  return { ...ctx, permissions: new Set(permissions), traps: () => traps };
}

describe("MCP URL state mapping", () => {
  it("sets every URL key to the parser default when absent", () => {
    expect(searchJobsParams({})).toEqual(loadJobsSearchParams(new URLSearchParams()));
  });

  it.each<[SearchJobsArgs, string]>([
    [{ query: "engineer" }, "q=engineer"], [{ search_in: "all" }, "searchIn=all"], [{ search_in: "summary" }, ""],
    [{ country: ["DE", "FR"] }, "country=DE&country=FR"], [{ city: "Sample City" }, "city=Sample+City"],
    [{ workplace: ["hybrid", "remote"] }, "workplace=hybrid&workplace=remote"],
    [{ min_rank: 0 }, "minScore=0"], [{ min_annual_salary: 50000 }, "minSalary=50000"],
    [{ since: "2026-10-01", until: "2026-10-15" }, "from=2026-10-01&to=2026-10-15"],
    [{ application_status: ["new", "applied"] }, "app=new&app=applied"],
    [{ sort: "first_seen" }, "sort=first_seen"], [{ sort: "posted" }, "sort=posted"],
    [{ sort: "rank" }, "sort=rank"], [{ sort: "relevance" }, "sort=relevance"],
    [{ scope: "archive" }, "scope=archive"], [{ scope: "all" }, "scope=all"], [{ scope: "current" }, "scope=current"],
    [{ unseen_only: true }, "unseen=true"], [{ unseen_only: false }, "unseen=false"],
    [{ favorites_only: true }, "fav=true"], [{ favorites_only: false }, "fav=false"],
    [{ visa: "offered" }, "visa=offered"], [{ visa: "not_denied" }, "visa=not_denied"],
    [{ ghost: "only" }, "ghost=only"], [{ ghost: "hide" }, "ghost=hide"], [{ limit: 3 }, ""],
  ])("maps %j to its web URL state", (args, query) => {
    expect(searchJobsParams(args)).toEqual(loadJobsSearchParams(new URLSearchParams(query)));
  });

  it.each([
    { scope: "ignored" }, { unseen_only: "true" }, { favorites_only: 1 }, { visa: "all" }, { ghost: "all" },
    { unseen_only: null }, { favorites_only: null }, { scope: 1 }, { visa: true }, { ghost: [] },
  ])("rejects invalid new arguments %j", (raw) => { expect(input.safeParse(raw).success).toBe(false); });

  it.each<[SearchJobsArgs, readonly Permission[] | undefined]>([
    [{ favorites_only: true }, ["jobs:read", "match:read", "notes:read"]], [{ unseen_only: true }, ["jobs:read"]], [{ unseen_only: true, favorites_only: false }, undefined],
  ])("refuses the star and seen filters %j as invalid input without tracking permission", async (args, permissions) => {
    const call = permissions === undefined ? ctx : context(permissions);
    await expect(searchJobs(call, args)).rejects.toMatchObject({ category: "invalid_input", message: ctx.text("errors.trackingFilter") });
    expect(listJobs).not.toHaveBeenCalled();
  });

  it.each<[SearchJobsArgs, readonly Permission[] | undefined]>([
    [{ application_status: ["applied"] }, ["jobs:read"]], [{ application_status: ["new"], favorites_only: false }, ["jobs:read", "match:read", "notes:read"]], [{ application_status: ["offer"] }, undefined],
  ])("refuses the application-status filter %j as invalid input without tracking permission, running no query", async (args, permissions) => {
    const call = permissions === undefined ? ctx : context(permissions);
    await expect(searchJobs(call, args)).rejects.toMatchObject({ category: "invalid_input", message: ctx.text("errors.trackingFilter") });
    expect(ctx.text("errors.trackingFilter")).toContain("application_status");
    expect(listJobs).not.toHaveBeenCalled();
  });

  it("applies the application-status filter with tracking permission", async () => {
    await searchJobs(context(["jobs:read", "tracking:read"]), { application_status: ["applied", "interviewing"] });
    expect(listJobs).toHaveBeenLastCalledWith(ctx.db, expect.objectContaining({ filters: expect.objectContaining({ applicationStatuses: ["applied", "interviewing"] }) }));
  });

  it("keeps the star and seen filters off without tracking permission and applies them with it", async () => {
    await searchJobs(context(["jobs:read"]), { favorites_only: false, unseen_only: false });
    expect(listJobs).toHaveBeenLastCalledWith(ctx.db, expect.objectContaining({ filters: expect.objectContaining({ favoritesOnly: false, unseenOnly: false }) }));
    await searchJobs(context(["jobs:read", "tracking:read"]), { favorites_only: true, unseen_only: true });
    expect(listJobs).toHaveBeenLastCalledWith(ctx.db, expect.objectContaining({ filters: expect.objectContaining({ favoritesOnly: true, unseenOnly: true }) }));
  });

  it("preserves all combined filters through the shared function, including fractional thresholds", async () => {
    const args = input.parse({ query: "AI", city: "Metro", workplace: ["remote"], country: ["DE"], min_rank: 70.5, min_annual_salary: 50000.5, since: "2026-10-01", until: "2026-10-15", application_status: ["applied"], unseen_only: true, favorites_only: true, scope: "all", visa: "offered", ghost: "hide" });
    await searchJobs(context(["jobs:read", "tracking:read"]), args);
    const filters = await jobsListFilters(ctx.db, { ...searchJobsParams(args), q: null }, { visa: true, ghost: true, now: ctx.now() });
    expect(listJobs).toHaveBeenLastCalledWith(ctx.db, expect.objectContaining({ filters: { ...filters, search: searchPlan("AI") }, visa: true, ghost: true }));
    expect(filters).toMatchObject({ minRank: 70.5, minAnnualSalary: 50000.5, cities: ["Metro"], workplaces: ["remote"], applicationStatuses: ["applied"], scope: "all", visa: "offered", ghost: "hide", unseenOnly: true, favoritesOnly: true });
  });

  it("ignores unavailable visa and ghost filters and passes availability to hydration", async () => {
    vi.mocked(visaFilterAvailable).mockResolvedValue(false);
    vi.mocked(ghostFilterAvailable).mockResolvedValue(false);
    await searchJobs(ctx, { visa: "offered", ghost: "only" });
    expect(listJobs).toHaveBeenLastCalledWith(ctx.db, expect.objectContaining({ visa: false, ghost: false, filters: expect.objectContaining({ visa: null, ghost: null }) }));
  });

  it("does not load city groups for a plain search, retaining lenient pipeline handling", async () => {
    vi.mocked(loadCityGroups).mockRejectedValue(new Error("invalid pipeline"));
    await searchJobs(ctx, { query: "AI" });
    expect(loadCityGroups).not.toHaveBeenCalled();
    expect(listJobs).toHaveBeenCalled();
  });

  it("keeps real lenient text search when pipeline settings fail", async () => {
    const pipeline = vi.spyOn(market, "loadPipeline").mockImplementation(() => { throw new Error("invalid pipeline"); });
    try {
      await searchJobs({ ...ctx, searchPlan: buildSearchPlanLenient }, { query: "Engineer" });
      expect(listJobs).toHaveBeenLastCalledWith(ctx.db, expect.objectContaining({ filters: expect.objectContaining({ search: expect.objectContaining({ status: "ok" }) }) }));
    } finally {
      pipeline.mockRestore();
    }
  });

  it("normalizes reversed dates like the web, unlike the previous empty MCP range", async () => {
    await searchJobs(ctx, { since: "2026-10-15", until: "2026-10-01" });
    expect(listJobs).toHaveBeenLastCalledWith(ctx.db, expect.objectContaining({ filters: expect.objectContaining({ from: "2026-10-01", to: "2026-10-15", dateField: "seen" }) }));
  });

  it("keeps the MCP rank default for archive and all scopes", async () => {
    for (const scope of ["archive", "all"] as const) {
      await searchJobs(ctx, { scope });
      expect(listJobs).toHaveBeenLastCalledWith(ctx.db, expect.objectContaining({ sort: "rank" }));
    }
  });

  it("keeps the limit, truncation notice and timeout failure", async () => {
    vi.mocked(listJobs).mockResolvedValue({ jobs: [card()], total: 50, page: 1, pageSize: 1, pageCount: 50 });
    const result = await searchJobs(ctx, { limit: 1 });
    expect(result).toMatchObject({ total: 50, returned: 1, truncated: true });
    expect(result.notices).toEqual([ctx.text("notice.thirdParty"), ctx.text("notice.truncated", { returned: 1, total: 50, limit: 1 })]);
    vi.mocked(listJobs).mockRejectedValue(new SearchTimeoutError());
    await expect(searchJobs(ctx, { query: "AI", search_in: "all" })).rejects.toMatchObject({ category: "search_timeout" });
  });
});

describe("MCP card permission blocks", () => {
  it.each<[string, readonly Permission[]]>([
    ["jobs only", ["jobs:read"]], ["default", ["jobs:read", "tracking:read"]],
    ["jobs and match", ["jobs:read", "match:read"]], ["default with match", ["jobs:read", "tracking:read", "match:read"]], ["all", PERMISSIONS],
  ])("releases exactly the permitted card fields: %s", async (_label, permissions) => {
    cards(card());
    const result = await searchJobs(context(permissions), {});
    const job = result.jobs[0]!;
    const match = permissions.includes("match:read");
    const tracking = permissions.includes("tracking:read");
    const expected = {
      ...toJobCardDto(card(), (text) => text),
      ...(match ? { match: { summary: SUMMARY, summary_lang: "en", summary_withheld: null, filter_result: "passed", filter_reasons: [FILTER] } } : {}),
      ...(tracking ? { tracking: { status: "applied", favorite: true, seen: true } } : {}),
    };
    expect(job).toEqual(expected);
    expect(searchJobsOutputFor(new Set(permissions)).parse(result)).toEqual(result);
    const json = JSON.stringify(result);
    expect(json).not.toContain(NOTE);
    expect(json).not.toContain(String(BONUS));
    expect(json.includes(SUMMARY)).toBe(match);
    expect(json.includes(FILTER)).toBe(match);
    expect(result.notices).toEqual([ctx.text("notice.thirdParty"), ...(match ? [ctx.text("notice.derived")] : [])]);
    expect(vi.mocked(currentTrapScanJobIds).mock.calls.length).toBe(match ? 1 : 0);
    expect(searchJobsOutputFor(new Set(["jobs:read"])).safeParse({ ...result, jobs: [{ ...job, tracking: { status: "new", favorite: false, seen: false } }] }).success).toBe(false);
  });

  it("missing call permissions gives the unchanged base card", async () => {
    cards(card());
    expect((await searchJobs(ctx, {})).jobs[0]).toEqual(toJobCardDto(card(), (text) => text));
    expect(currentTrapScanJobIds).not.toHaveBeenCalled();
  });

  it("uses the MCP locale, then output language, English, then any available language", async () => {
    cards(card(), card({ id: 8, summary: { texts: { de: "Ausgabe", en: "English" }, outputLang: "de" } }), card({ id: 9, summary: { texts: { en: "English" }, outputLang: "de" } }), card({ id: 10, summary: { texts: { fr: "Autre" }, outputLang: null } }));
    vi.mocked(currentTrapScanJobIds).mockResolvedValue(new Set([7, 8, 9, 10]));
    const result = await searchJobs({ ...context(["jobs:read", "match:read"]), text: mcpTranslator("zh") }, {});
    expect(result.jobs.map((job) => [job.match?.summary, job.match?.summary_lang])).toEqual([["摘要", "zh"], ["Ausgabe", "de"], ["English", "en"], ["Autre", "fr"]]);
  });

  it("cleans every short match field including summaries and filter reasons", async () => {
    const base = card();
    cards(card({ summary: { texts: { en: "Summary\u200b" }, outputLang: "en" }, rank: { ...base.rank!, filterReasons: ["Reason\u200b"] } }));
    const result = await searchJobs(context(["jobs:read", "match:read"]), {});
    expect(result.jobs[0]?.match).toMatchObject({ summary: "Summary", filter_reasons: ["Reason"] });
  });

  it.each(["traps_disabled", "settings_unreadable", "not_scanned", "findings_unreadable"] as const)("withholds summaries with %s and one notice", async (reason) => {
    cards(card(), card({ id: 8 }));
    const c = context(["jobs:read", "match:read"]);
    if (reason === "traps_disabled") c.traps = () => ({ ...traps, enabled: false });
    if (reason === "settings_unreadable") c.traps = () => { throw new Error("unreadable"); };
    if (reason === "not_scanned") vi.mocked(currentTrapScanJobIds).mockResolvedValue(new Set());
    if (reason === "findings_unreadable") vi.mocked(currentTrapScanJobIds).mockRejectedValue(new Error("query failed"));
    const result = await searchJobs(c, {});
    for (const job of result.jobs) expect(job.match).toEqual({ summary: null, summary_lang: null, summary_withheld: reason, filter_result: "passed", filter_reasons: [FILTER] });
    expect(result.notices).toEqual([c.text("notice.thirdParty"), c.text("notice.derivedWithheld")]);
    if (reason === "traps_disabled" || reason === "settings_unreadable") expect(currentTrapScanJobIds).not.toHaveBeenCalled();
  });

  it("guards each job in one batch, and notices both given and withheld summaries once before truncation", async () => {
    vi.mocked(listJobs).mockResolvedValue({ jobs: [card(), card({ id: 8 }), card({ id: 9, summary: null }), card({ id: 10, summary: { texts: { en: "  " }, outputLang: "en" }, rank: null, favorite: null, applicationStatus: null, seen: false })], total: 50, page: 1, pageSize: 4, pageCount: 13 });
    const result = await searchJobs(context(PERMISSIONS), { limit: 4 });
    expect(currentTrapScanJobIds).toHaveBeenCalledOnce();
    expect(currentTrapScanJobIds).toHaveBeenCalledWith(ctx.db, [7, 8, 9, 10], expect.any(String));
    expect(result.jobs.map((job) => job.match?.summary_withheld)).toEqual([null, "not_scanned", null, null]);
    expect(result.jobs[3]).toMatchObject({ match: { summary: null, summary_lang: null, filter_result: null, filter_reasons: [] }, tracking: { status: "new", favorite: false, seen: false } });
    expect(result.notices).toEqual([ctx.text("notice.thirdParty"), ctx.text("notice.derived"), ctx.text("notice.derivedWithheld"), ctx.text("notice.truncated", { returned: 4, total: 50, limit: 4 })]);
  });
});

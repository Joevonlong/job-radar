// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";

import { giveBackAgentBudget, takeIndirectBudget, type BudgetTicket } from "@/lib/agent-access/budget";
import { researchSchema, salarySchema } from "@/lib/config";
import type { ResearchItem } from "@/lib/config/schemas/research";
import type { Db } from "@/lib/db/client";
import { requestBreakdownJob } from "@/lib/control/breakdown-request";
import { requestCompanyResearch } from "@/lib/control/company-research-request";
import { requestSalaryLookup } from "@/lib/control/salary-request";
import { companyResearchCurrent } from "@/lib/db/repos/company-research";
import { hasRecentAutoRun, reserveAutoResearchRun } from "@/lib/db/repos/research-auto-runs";
import { requestAutoResearch, type AutoResearchDeps } from "@/lib/research/auto";
import { pinnedAi } from "../ai/helpers";

vi.mock("@/lib/agent-access/budget", () => ({ takeIndirectBudget: vi.fn(), giveBackAgentBudget: vi.fn() }));
vi.mock("@/lib/db/repos/activity", () => ({ activityTablesReady: async () => false }));
vi.mock("@/lib/db/repos/company-research", () => ({ getJobForCompanyResearch: async () => ({ companyId: 2 }), findLatestCompanyResearch: async () => null, companyResearchCurrent: vi.fn(), confirmedWebsiteDomain: () => null }));
vi.mock("@/lib/db/repos/salary-lookups", () => ({ getJobForSalaryLookup: async () => ({ companyNorm: "example", title: "ML engineer", titleNorm: "ml engineer", seniority: null, location: null }), findLatestSalaryLookup: async () => null }));
vi.mock("@/lib/db/repos/breakdowns", () => ({ getJobForBreakdown: async () => ({ description: "Build reliable software." }), getJobBreakdown: async () => null }));
vi.mock("@/lib/db/repos/research-auto-runs", () => ({ hasRecentAutoRun: vi.fn(), reserveAutoResearchRun: vi.fn(), updateAutoRunItems: async () => undefined }));
vi.mock("@/lib/control/company-research-request", () => ({ companyResearchProviders: () => ["anthropic"], requestCompanyResearch: vi.fn() }));
vi.mock("@/lib/control/salary-request", () => ({ salaryLookupProviders: () => ["anthropic"], requestSalaryLookup: vi.fn() }));
vi.mock("@/lib/control/breakdown-request", () => ({ requestBreakdownJob: vi.fn() }));

const db = { transaction: async (cb: (db: Db) => Promise<unknown>) => cb(db) } as Db;
const tickets = {
  company: { id: "company-ticket", caller: "stdio", action: "research_company", day: "2026-11-11", units: 1 },
  salary: { id: "salary-ticket", caller: "stdio", action: "research_salary", day: "2026-11-11", units: 1 },
} as const satisfies Record<string, BudgetTicket>;
const input = { jobId: 3, event: "status", caller: "stdio", now: new Date("2026-11-11T12:00:00Z") } as const;

function deps(items: ResearchItem[] = ["company"], overrides: Partial<AutoResearchDeps> = {}): AutoResearchDeps {
  return {
    research: () => researchSchema.parse({ enabled: true, company: { ttl_days: 30, max_per_day: 3, max_searches: 8, timeout_seconds: 60, max_field_chars: 400, allowed_domains: ["example.com"], non_company_hosts: [], employees: { min: 1, max: 1000000 }, rating: { min: 0, max: 5 }, web_search_usd: 0.01 }, auto: { trigger: "favorite_or_applying", items, max_per_day: 10, high_score: { enabled: false, min_rank: 80, per_cycle_limit: 2, max_age_days: 3, max_per_day: 5 } } }),
    ai: () => pinnedAi(),
    salary: () => ({ state: "ok", config: salarySchema.parse({
      benchmark: { enabled: true, window_days: 365, min_sample: 3 },
      role_families: [{ id: "ml_engineer", label: { en: "ML engineer" }, patterns: ["\\bml engineer\\b"] }],
      deep_links: [],
      lookup: { enabled: true, ttl_days: 30, max_per_day: 3, timeout_seconds: 60, max_searches: 4, allowed_fetch_domains: ["levels.fyi"], sanity_annual: { min: 5000, max: 2000000 }, unconvertible_max_annual: 100_000_000_000 },
    }) }),
    breakdown: () => ({ state: "ok", config: { enabled: true, mode: "manual", auto: { min_rank: 70, per_cycle_limit: 5 }, jd_max_chars: 12000, jd_head_share: 0.7, timeout_seconds: 240 } }),
    timeZone: () => "UTC", process: "web", webOpen: async () => true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(takeIndirectBudget).mockImplementation(async (_db, { action }) => ({ decision: "go", ticket: action === "research_company" ? tickets.company : tickets.salary }));
  vi.mocked(giveBackAgentBudget).mockResolvedValue(true);
  vi.mocked(companyResearchCurrent).mockReturnValue(false);
  vi.mocked(hasRecentAutoRun).mockResolvedValue(false);
  vi.mocked(reserveAutoResearchRun).mockResolvedValue({ state: "reserved", runId: 1 });
  vi.mocked(requestCompanyResearch).mockResolvedValue({ state: "queued", requestId: 1, existing: false });
  vi.mocked(requestSalaryLookup).mockResolvedValue({ state: "queued", requestId: 2, existing: false });
  vi.mocked(requestBreakdownJob).mockResolvedValue({ state: "queued", requestId: 3, existing: false });
});

it("charges only company research for a company-only run", async () => {
  expect(await requestAutoResearch(db, input, deps())).toEqual({ outcome: "queued", items: { company: "queued" } });
  expect(takeIndirectBudget).toHaveBeenCalledExactlyOnceWith(db, { caller: "stdio", action: "research_company" });
  expect(vi.mocked(takeIndirectBudget).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(requestCompanyResearch).mock.invocationCallOrder[0]);
  expect(requestSalaryLookup).not.toHaveBeenCalled();
  expect(giveBackAgentBudget).not.toHaveBeenCalled();
});

it.each([false, true])("charges only salary research when company research is cached: %s", async (companyCached) => {
  vi.mocked(companyResearchCurrent).mockReturnValue(companyCached);
  const result = await requestAutoResearch(db, input, deps(companyCached ? ["company", "salary"] : ["salary"]));
  expect(result).toEqual({ outcome: "queued", items: { ...(companyCached ? { company: "cached" } : {}), salary: "queued" } });
  expect(takeIndirectBudget).toHaveBeenCalledExactlyOnceWith(db, { caller: "stdio", action: "research_salary" });
  expect(requestCompanyResearch).not.toHaveBeenCalled();
  expect(requestSalaryLookup).toHaveBeenCalledOnce();
  expect(giveBackAgentBudget).not.toHaveBeenCalled();
});

it.each<{ items: ResearchItem[] }>([
  { items: ["company", "salary"] },
  { items: ["company", "breakdown", "salary"] },
  { items: ["salary", "company"] },
])("reserves both lookup buckets in item order before any work is queued: $items", async ({ items }) => {
  expect((await requestAutoResearch(db, input, deps(items))).outcome).toBe("queued");
  expect(vi.mocked(takeIndirectBudget).mock.calls.map(([, request]) => request.action)).toEqual(items.filter((item) => item !== "breakdown").map((item) => tickets[item].action));
  const lastTake = vi.mocked(takeIndirectBudget).mock.invocationCallOrder[1];
  expect(lastTake).toBeLessThan(vi.mocked(reserveAutoResearchRun).mock.invocationCallOrder[0]);
  expect(lastTake).toBeLessThan(vi.mocked(requestCompanyResearch).mock.invocationCallOrder[0]);
  expect(lastTake).toBeLessThan(vi.mocked(requestSalaryLookup).mock.invocationCallOrder[0]);
  expect(requestBreakdownJob).toHaveBeenCalledTimes(items.includes("breakdown") ? 1 : 0);
  expect(giveBackAgentBudget).not.toHaveBeenCalled();
});

it("does not charge a breakdown-only run", async () => {
  expect(await requestAutoResearch(db, input, deps(["breakdown"]))).toEqual({ outcome: "queued", items: { breakdown: "queued" } });
  expect(requestBreakdownJob).toHaveBeenCalledOnce();
  expect(takeIndirectBudget).not.toHaveBeenCalled();
  expect(giveBackAgentBudget).not.toHaveBeenCalled();
});

it.each(["company", "salary"] as const)("skips all work when the first %s bucket refuses", async (first) => {
  vi.mocked(takeIndirectBudget).mockResolvedValue({ decision: "skip", reason: "caller_cap", refusal: null });
  expect(await requestAutoResearch(db, input, deps([first, "breakdown", first === "company" ? "salary" : "company"]))).toEqual({ outcome: "budget_skipped", items: {} });
  expect(takeIndirectBudget).toHaveBeenCalledExactlyOnceWith(db, { caller: "stdio", action: tickets[first].action });
  expect(reserveAutoResearchRun).not.toHaveBeenCalled();
  expect(requestCompanyResearch).not.toHaveBeenCalled();
  expect(requestSalaryLookup).not.toHaveBeenCalled();
  expect(requestBreakdownJob).not.toHaveBeenCalled();
  expect(giveBackAgentBudget).not.toHaveBeenCalled();
});

it.each(["company", "salary"] as const)("returns the first ticket when the second %s bucket has a zero cap", async (second) => {
  const first = second === "company" ? "salary" : "company";
  vi.mocked(takeIndirectBudget)
    .mockResolvedValueOnce({ decision: "go", ticket: tickets[first] })
    .mockResolvedValueOnce({ decision: "skip", reason: "not_allowed", refusal: { reason: "not_allowed", action: tickets[second].action, cap: 0, used: 0, remaining: 0, requested: 1, resetsAt: new Date("2026-11-12T00:00:00Z") } });
  expect(await requestAutoResearch(db, input, deps([first, "breakdown", second]))).toEqual({ outcome: "budget_skipped", items: {} });
  expect(takeIndirectBudget).toHaveBeenCalledTimes(2);
  expect(giveBackAgentBudget).toHaveBeenCalledExactlyOnceWith(db, tickets[first]);
  expect(reserveAutoResearchRun).not.toHaveBeenCalled();
  expect(requestCompanyResearch).not.toHaveBeenCalled();
  expect(requestSalaryLookup).not.toHaveBeenCalled();
  expect(requestBreakdownJob).not.toHaveBeenCalled();
});

it.each([
  { item: "company", state: "cached" }, { item: "salary", state: "cached" },
  { item: "company", state: "existing" }, { item: "salary", state: "existing" },
  { item: "company", state: "error" }, { item: "salary", state: "error" },
] as const)("refunds only $item when it is $state and the other lookup is newly queued", async ({ item, state }) => {
  const request = item === "company" ? requestCompanyResearch : requestSalaryLookup;
  vi.mocked(request).mockResolvedValue(state === "existing" ? { state: "queued", requestId: 4, existing: true } : state === "error" ? { state, error: "quota" } : { state });
  const result = await requestAutoResearch(db, input, deps(["company", "salary"]));
  expect(result).toEqual({ outcome: "queued", items: { company: "queued", salary: "queued", [item]: state === "existing" ? "queued" : state === "error" ? "failed" : "cached" } });
  expect(takeIndirectBudget).toHaveBeenCalledTimes(2);
  expect(giveBackAgentBudget).toHaveBeenCalledExactlyOnceWith(db, tickets[item]);
});

it("refunds both lookups even when a breakdown was newly queued", async () => {
  vi.mocked(requestCompanyResearch).mockResolvedValue({ state: "cached" });
  vi.mocked(requestSalaryLookup).mockResolvedValue({ state: "error", error: "quota" });
  expect(await requestAutoResearch(db, input, deps(["company", "breakdown", "salary"]))).toEqual({ outcome: "queued", items: { company: "cached", breakdown: "queued", salary: "failed" } });
  expect(giveBackAgentBudget).toHaveBeenCalledTimes(2);
  expect(giveBackAgentBudget).toHaveBeenNthCalledWith(1, db, tickets.company);
  expect(giveBackAgentBudget).toHaveBeenNthCalledWith(2, db, tickets.salary);
});

it.each(["recent", "cap_reached", "reserve_throw", "request_throw"] as const)("refunds both reservations when no work is added: %s", async (state) => {
  if (state === "recent") vi.mocked(reserveAutoResearchRun).mockResolvedValue({ state });
  else if (state === "cap_reached") vi.mocked(reserveAutoResearchRun).mockResolvedValue({ state, used: 10 });
  else if (state === "reserve_throw") vi.mocked(reserveAutoResearchRun).mockRejectedValue(new Error("failed"));
  else vi.mocked(requestCompanyResearch).mockRejectedValue(new Error("failed"));
  expect((await requestAutoResearch(db, input, deps(["company", "salary"]))).outcome).toBe(state === "recent" || state === "cap_reached" ? state : "failed");
  expect(requestSalaryLookup).not.toHaveBeenCalled();
  expect(giveBackAgentBudget).toHaveBeenCalledTimes(2);
  expect(giveBackAgentBudget).toHaveBeenNthCalledWith(1, db, tickets.company);
  expect(giveBackAgentBudget).toHaveBeenNthCalledWith(2, db, tickets.salary);
});

it("refunds the unqueued salary lookup when it throws after company work was added", async () => {
  vi.mocked(requestSalaryLookup).mockRejectedValue(new Error("failed"));
  expect((await requestAutoResearch(db, input, deps(["company", "salary"]))).outcome).toBe("failed");
  expect(requestCompanyResearch).toHaveBeenCalledOnce();
  expect(giveBackAgentBudget).toHaveBeenCalledExactlyOnceWith(db, tickets.salary);
});

it("refunds an earlier ticket if taking the next ticket throws", async () => {
  vi.mocked(takeIndirectBudget).mockResolvedValueOnce({ decision: "go", ticket: tickets.company }).mockRejectedValueOnce(new Error("failed"));
  expect((await requestAutoResearch(db, input, deps(["company", "salary"]))).outcome).toBe("failed");
  expect(giveBackAgentBudget).toHaveBeenCalledExactlyOnceWith(db, tickets.company);
  expect(reserveAutoResearchRun).not.toHaveBeenCalled();
});

it.each(["off", "recent", "all_cached", "nothing_to_run", "deferred_quota"] as const)("does not take tickets for an early %s result", async (outcome) => {
  const settings = deps();
  if (outcome === "off") settings.research = () => ({ ...deps().research(), enabled: false });
  else if (outcome === "recent") vi.mocked(hasRecentAutoRun).mockResolvedValue(true);
  else if (outcome === "all_cached") vi.mocked(companyResearchCurrent).mockReturnValue(true);
  else if (outcome === "nothing_to_run") settings.research = deps([]).research;
  else settings.webOpen = async () => false;
  expect((await requestAutoResearch(db, input, settings)).outcome).toBe(outcome);
  expect(takeIndirectBudget).not.toHaveBeenCalled();
  expect(giveBackAgentBudget).not.toHaveBeenCalled();
  expect(reserveAutoResearchRun).not.toHaveBeenCalled();
});

it("owner research never touches agent budgets for any item", async () => {
  expect((await requestAutoResearch(db, { ...input, caller: undefined }, deps(["company", "salary", "breakdown"]))).outcome).toBe("queued");
  expect(requestCompanyResearch).toHaveBeenCalledOnce();
  expect(requestSalaryLookup).toHaveBeenCalledOnce();
  expect(requestBreakdownJob).toHaveBeenCalledOnce();
  expect(takeIndirectBudget).not.toHaveBeenCalled();
  expect(giveBackAgentBudget).not.toHaveBeenCalled();
});

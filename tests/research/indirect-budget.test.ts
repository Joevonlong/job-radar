// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";

import { giveBackAgentBudget, takeIndirectBudget } from "@/lib/agent-access/budget";
import { researchSchema } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { requestCompanyResearch } from "@/lib/control/company-research-request";
import { reserveAutoResearchRun } from "@/lib/db/repos/research-auto-runs";
import { requestAutoResearch, type AutoResearchDeps } from "@/lib/research/auto";
import { pinnedAi } from "../ai/helpers";

vi.mock("@/lib/agent-access/budget", () => ({ takeIndirectBudget: vi.fn(), giveBackAgentBudget: vi.fn(async () => true) }));
vi.mock("@/lib/db/repos/activity", () => ({ activityTablesReady: async () => false }));
vi.mock("@/lib/db/repos/company-research", () => ({ getJobForCompanyResearch: async () => ({ companyId: 2 }), findLatestCompanyResearch: async () => null, companyResearchCurrent: () => false, confirmedWebsiteDomain: () => null }));
vi.mock("@/lib/db/repos/research-auto-runs", () => ({ hasRecentAutoRun: async () => false, reserveAutoResearchRun: vi.fn(), updateAutoRunItems: async () => undefined }));
vi.mock("@/lib/control/company-research-request", () => ({ companyResearchProviders: () => ["anthropic"], requestCompanyResearch: vi.fn() }));
const db = { transaction: async (cb: (db: Db) => Promise<unknown>) => cb(db) } as Db;
const ticket = { id: "ticket", caller: "stdio", action: "research_company", day: "2026-11-11", units: 1 } as const;
const deps: AutoResearchDeps = {
  research: () => researchSchema.parse({ enabled: true, company: { ttl_days: 30, max_per_day: 3, max_searches: 8, timeout_seconds: 60, max_field_chars: 400, allowed_domains: ["example.com"], non_company_hosts: [], employees: { min: 1, max: 1000000 }, rating: { min: 0, max: 5 }, web_search_usd: 0.01 }, auto: { trigger: "favorite_or_applying", items: ["company"], max_per_day: 10, high_score: { enabled: false, min_rank: 80, per_cycle_limit: 2, max_age_days: 3, max_per_day: 5 } } }),
  ai: () => pinnedAi(), salary: () => ({ state: "error", problem: "test" }), breakdown: () => ({ state: "error", problem: "test" }),
  timeZone: () => "UTC", process: "web", webOpen: async () => true,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(takeIndirectBudget).mockResolvedValue({ decision: "go", ticket });
  vi.mocked(reserveAutoResearchRun).mockResolvedValue({ state: "reserved", runId: 1 });
  vi.mocked(requestCompanyResearch).mockResolvedValue({ state: "queued", requestId: 1, existing: false });
});
it("skips before reserving or queuing when the agent budget refuses", async () => {
  vi.mocked(takeIndirectBudget).mockResolvedValue({ decision: "skip", reason: "caller_cap", refusal: null });
  expect(await requestAutoResearch(db, { jobId: 3, event: "status", caller: "stdio" }, deps)).toEqual({ outcome: "budget_skipped", items: {} });
  expect(reserveAutoResearchRun).not.toHaveBeenCalled();
  expect(requestCompanyResearch).not.toHaveBeenCalled();
});
it("takes before queuing and retains the ticket for newly queued work", async () => {
  expect((await requestAutoResearch(db, { jobId: 3, event: "status", caller: "stdio" }, deps)).outcome).toBe("queued");
  expect(takeIndirectBudget).toHaveBeenCalledWith(db, { caller: "stdio", action: "research_company" });
  expect(vi.mocked(takeIndirectBudget).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(requestCompanyResearch).mock.invocationCallOrder[0]);
  expect(giveBackAgentBudget).not.toHaveBeenCalled();
});
it.each(["recent", "cap_reached", "cached", "existing", "error", "throw"] as const)("gives back a ticket when nothing new is queued: %s", async (state) => {
  if (state === "recent") vi.mocked(reserveAutoResearchRun).mockResolvedValue({ state });
  else if (state === "cap_reached") vi.mocked(reserveAutoResearchRun).mockResolvedValue({ state, used: 10 });
  else if (state === "cached") vi.mocked(requestCompanyResearch).mockResolvedValue({ state });
  else if (state === "existing") vi.mocked(requestCompanyResearch).mockResolvedValue({ state: "queued", requestId: 1, existing: true });
  else if (state === "error") vi.mocked(requestCompanyResearch).mockResolvedValue({ state, error: "quota" });
  else vi.mocked(requestCompanyResearch).mockRejectedValue(new Error("failed"));
  await requestAutoResearch(db, { jobId: 3, event: "status", caller: "stdio" }, deps);
  expect(giveBackAgentBudget).toHaveBeenCalledExactlyOnceWith(db, ticket);
});
it("owner research never touches the agent budget", async () => {
  expect((await requestAutoResearch(db, { jobId: 3, event: "status" }, deps)).outcome).toBe("queued");
  expect(takeIndirectBudget).not.toHaveBeenCalled();
  expect(giveBackAgentBudget).not.toHaveBeenCalled();
});

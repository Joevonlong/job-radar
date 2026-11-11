// @vitest-environment node
import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ policy: vi.fn(() => { throw new Error("interests.yaml unreadable"); }), list: vi.fn(async () => ({ jobs: [], total: 0, page: 1, pageCount: 1 })) }));
vi.mock("next-intl/server", () => ({ getLocale: async () => "en", getFormatter: async () => ({ dateTime: () => "time", relativeTime: () => "relative" }), getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/config", async (original) => { const actual = await original<typeof import("@/lib/config")>(); return { ...actual, loadConfig: (name: Parameters<typeof actual.loadConfig>[0]) => { if (name === "interests") throw new Error("interests.yaml unreadable"); return actual.loadConfig(name); } }; });
vi.mock("@/lib/signals/floor", async (original) => ({ ...await original<object>(), loadHighValuePolicy: state.policy }));
vi.mock("@/lib/db", async (original) => ({ ...await original<object>(), getDb: () => ({}), listJobs: state.list, getVisitState: async () => null, getFilterFloors: async () => new Map(), getJobFilterOptions: async () => ({}), countJobListSeen: async () => ({ total: 0, unseen: 0, newSince: 0 }), countJobList: async () => 0, listMonthSalaryFigures: async () => [], listCompanyFilterOptions: async () => [], listJobCountryOptions: async () => [] }));
vi.mock("@/lib/jobs/cities", () => ({ loadCityGroups: async () => [] }));
vi.mock("@/lib/db/repos/listing", () => ({ listingReady: async () => true }));
vi.mock("@/lib/visa/filter", () => ({ visaFilterAvailable: async () => false }));
vi.mock("@/lib/ghost/filter", () => ({ ghostFilterAvailable: async () => false }));
import JobsPage from "@/app/jobs/page";
it("renders the jobs page with unreadable interests while high-value filtering is off", async () => {
  const page = await JobsPage({ searchParams: Promise.resolve({}) });
  expect(page).toBeDefined();
  expect(state.policy).not.toHaveBeenCalled();
  expect(state.list).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ filters: expect.objectContaining({ highValue: null }) }));
  await expect(JobsPage({ searchParams: Promise.resolve({ high: "true" }) })).rejects.toThrow("interests.yaml unreadable");
});

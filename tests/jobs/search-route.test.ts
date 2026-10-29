// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})), listJobs: vi.fn() }));
vi.mock("@/lib/dashboard/context", () => ({ getSchedule: () => ({ timezone: "UTC" }) }));
vi.mock("@/lib/jobs/search", async () => ({
  buildSearchPlan: (await import("../fixtures/job-search")).searchPlan,
  jobSearchSettings: () => ({ query: { max_chars: 20 }, palette: { min_chars: 3, limit: 5 } }),
}));

import { GET } from "@/app/api/search/route";
import { listJobs } from "@/lib/db";

import { searchPlan } from "../fixtures/job-search";

beforeEach(() => {
  vi.mocked(listJobs).mockReset().mockResolvedValue({ jobs: [], total: 0, page: 1, pageCount: 1, pageSize: 5 });
});
const request = (q: string) => new Request(`http://localhost/api/search?q=${encodeURIComponent(q)}`);

describe("palette search route", () => {
  it("validates trimmed input using configured limits before touching the database", async () => {
    for (const q of ["", " a ", "AI"]) {
      const response = await GET(request(q));
      expect(await response.json()).toEqual({ jobs: [] });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(listJobs).not.toHaveBeenCalled();
  });

  it("truncates over-long input to the configured limit and searches that prefix", async () => {
    const prefix = "x".repeat(20);
    const response = await GET(request(`  ${prefix} ignored suffix  `));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(listJobs).toHaveBeenCalledWith({}, expect.objectContaining({ filters: { search: searchPlan(prefix), includeFiltered: false } }));
  });

  it("uses the shared summary matcher, relevance and configured palette size", async () => {
    const response = await GET(request("  Berlin  "));
    expect(response.status).toBe(200);
    expect(listJobs).toHaveBeenCalledWith({}, { filters: { search: searchPlan("Berlin"), includeFiltered: false }, sort: "relevance", page: 1, pageSize: 5, timezone: "UTC" });
    expect(await response.json()).toEqual({ jobs: [] });
  });

  it("does not log query text when a database call fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(listJobs).mockRejectedValue(new Error("secret-query"));
      expect((await GET(request("secret-query"))).status).toBe(500);
      expect(log).toHaveBeenCalledWith("[search] failed:", "Error");
      expect(JSON.stringify(log.mock.calls)).not.toContain("secret-query");
    } finally { log.mockRestore(); }
  });
});

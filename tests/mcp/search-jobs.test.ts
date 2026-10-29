// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/queries/jobs", () => ({ listJobs: vi.fn() }));
import { listJobs } from "@/lib/db/queries/jobs";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import type { McpContext } from "@/lib/mcp/context";
import { defaultContext } from "@/lib/mcp/server";
import { mcpTranslator } from "@/lib/mcp/text";
import { searchJobs, searchJobsInput } from "@/lib/mcp/tools/search-jobs";
import type { Db } from "@/lib/db";

import { searchPlan } from "../fixtures/job-search";

const ctx: McpContext = { ...defaultContext({} as Db, mcpSchema.parse({ enabled: true })), searchPlan, timezone: () => "UTC", log: vi.fn() };
const input = searchJobsInput({ text: mcpTranslator("en") });
beforeEach(() => {
  vi.mocked(listJobs).mockReset().mockResolvedValue({ jobs: [], total: 0, page: 1, pageSize: 20, pageCount: 1 });
});

describe("MCP search parameters", () => {
  it("accepts and uppercases bounded exact country codes and both search scopes", () => {
    expect(input.parse({ country: ["de", "Fr"], search_in: "all", sort: "relevance" })).toMatchObject({ country: ["DE", "FR"], search_in: "all", sort: "relevance" });
    for (const raw of [{ country: [] }, { country: ["DEU"] }, { country: Array(21).fill("DE") }, { search_in: "jd" }]) expect(input.safeParse(raw).success).toBe(false);
  });

  it("defaults query calls to relevance and summary, passing the shared plan and optional country/all scope", async () => {
    await searchJobs(ctx, input.parse({ query: "AI", country: ["de"], search_in: "all" }));
    expect(listJobs).toHaveBeenLastCalledWith(ctx.db, expect.objectContaining({ sort: "relevance", filters: { search: searchPlan("AI"), countries: ["DE"], searchIn: "all", includeFiltered: false } }));
    await searchJobs(ctx, input.parse({ query: "AI" }));
    expect(listJobs).toHaveBeenLastCalledWith(ctx.db, expect.objectContaining({ sort: "relevance", filters: expect.objectContaining({ searchIn: "summary" }) }));
    await searchJobs(ctx, input.parse({ query: "AI", sort: "rank" }));
    expect(listJobs).toHaveBeenLastCalledWith(ctx.db, expect.objectContaining({ sort: "rank" }));
    const output = await searchJobs(ctx, input.parse({}));
    expect(listJobs).toHaveBeenLastCalledWith(ctx.db, expect.objectContaining({ sort: "rank" }));
    expect(Object.keys(output).sort()).toEqual(["jobs", "notices", "returned", "total", "truncated"]);
  });

  it("propagates search configuration errors instead of silently changing the matcher", async () => {
    const fail = () => { throw new Error("invalid config"); };
    await expect(searchJobs({ ...ctx, searchPlan: fail }, input.parse({ query: "AI" }))).rejects.toThrow("invalid config");
    expect(listJobs).not.toHaveBeenCalled();
  });
});

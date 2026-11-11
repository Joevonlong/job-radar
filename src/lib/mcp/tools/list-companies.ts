import { z } from "zod";
import { MCP_MAX_RESULTS_CAP } from "@/lib/config/schemas/mcp";
import { companyOverviewDependencies, loadCompanyOverviewParams } from "@/lib/companies/overview-data";
import { listCompanyOverview } from "@/lib/db/queries/companies";
import { MAX_FILTER_VALUE_CHARS } from "@/lib/jobs/constants";
import type { McpContext } from "../context";
import { listCompaniesOutput } from "../dto/companies";
import { readTextCleaner } from "../read-guard";
import { readTraps, resultLimit } from "./shared";
import { readNotices } from "./read-shared";

export function listCompaniesInput(ctx: Pick<McpContext, "text">) {
  return z.strictObject({ query: z.string().trim().min(1).max(MAX_FILTER_VALUE_CHARS).optional().describe(ctx.text("params.companyQuery")), sort: z.enum(["jobs", "score", "recent"]).optional().describe(ctx.text("params.companySort")), limit: z.number().int().min(1).max(MCP_MAX_RESULTS_CAP).optional().describe(ctx.text("params.limit")) });
}
export async function listCompanies(ctx: McpContext, args: z.infer<ReturnType<typeof listCompaniesInput>>) {
  const limit = resultLimit(ctx, args.limit);
  const data = await loadCompanyOverviewParams({ q: args.query ?? "", sort: args.sort ?? "jobs", dir: "desc", page: 1 }, { loadSettings: () => ({ ...companyOverviewDependencies.loadSettings(), pageSize: limit, timezone: ctx.timezone() }), list: (options) => listCompanyOverview(ctx.db, options) });
  const clean = readTextCleaner(readTraps(ctx), ctx.text("notice.redacted"));
  const companies = data.rows.map((row) => ({ id: row.id, name: clean(row.name), watched: row.watched, blacklisted: row.excluded, job_count: row.jobCount, top_rank: row.topRank, last_first_seen_at: row.lastFirstSeenAt.toISOString(), text_withheld: null }));
  return listCompaniesOutput.parse({ notices: readNotices(ctx, companies.length, data.total, limit, companies.some((row) => row.text_withheld !== null)), total: data.total, returned: companies.length, truncated: data.total > companies.length, companies });
}

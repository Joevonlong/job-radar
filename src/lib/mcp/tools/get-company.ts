import { z } from "zod";
import { MCP_MAX_RESULTS_CAP } from "@/lib/config/schemas/mcp";
import { companyOverviewDependencies } from "@/lib/companies/overview-data";
import { buildBlacklistedCompanyKeys, buildWatchedCompanyKeys, isCompanyExcluded, isCompanyWatched } from "@/lib/companies/marks";
import { getCompanyById } from "@/lib/db/repos/companies";
import { getCompanyResearchWithJob } from "@/lib/db/repos/company-research";
import { listJobs } from "@/lib/db/queries/jobs";
import { COMPANY_RESEARCH_FIELDS } from "@/lib/research/fields";
import { companyFieldText, httpsUrlOrNull } from "@/lib/writer/company-background";
import { ToolFailure, type McpContext } from "../context";
import { getCompanyOutputFor } from "../dto/companies";
import { readSourceUrl, readTextAccess, readTextCleaner } from "../read-guard";
import { readTraps, resultLimit } from "./shared";
import { limitReadOutput, readCards, readNotices } from "./read-shared";

export function getCompanyInput(ctx: Pick<McpContext, "text">) {
  return z.strictObject({ company_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe(ctx.text("params.companyId")), limit: z.number().int().min(1).max(MCP_MAX_RESULTS_CAP).optional().describe(ctx.text("params.limit")) });
}
/** Watched and blacklisted are read from the owner's interests and preferences, so only under profile:read. */
function companyMarks(company: Parameters<typeof isCompanyWatched>[0] & Parameters<typeof isCompanyExcluded>[0]): { watched: boolean; blacklisted: boolean } {
  const settings = companyOverviewDependencies.loadSettings();
  return {
    watched: isCompanyWatched(company, buildWatchedCompanyKeys(settings.watchedCompanies, settings.pipeline)),
    blacklisted: isCompanyExcluded(company, buildBlacklistedCompanyKeys(settings.excludedCompanies, settings.pipeline), settings.pipeline.company.legal_suffixes),
  };
}

export async function getCompany(ctx: McpContext, args: z.infer<ReturnType<typeof getCompanyInput>>) {
  const company = await getCompanyById(ctx.db, args.company_id);
  if (company === null) throw new ToolFailure("not_found", ctx.text("errors.companyNotFound", { id: args.company_id }));
  const limit = resultLimit(ctx, args.limit);
  const clean = readTextCleaner(readTraps(ctx), ctx.text("notice.redacted"));
  const marks = ctx.permissions?.has("profile:read") ? companyMarks(company) : {};
  const page = await listJobs(ctx.db, { filters: { companyIds: [company.id], statuses: ["active"], scope: "current" }, sort: "rank", page: 1, pageSize: limit, timezone: ctx.timezone(), visa: false, ghost: false });
  const jobs = await readCards(ctx, page.jobs);
  const result = await getCompanyResearchWithJob(ctx.db, company.id, ctx.now());
  const access = result === null ? null : await readTextAccess(ctx, result.job ? [result.job] : []);
  const row = result?.research ?? null;
  const research = row === null || access === null ? null : {
    available: access.reason === null, reason: access.reason,
    fetched_at: row.fetchedAt.toISOString(), expired: row.expired,
    fields: COMPANY_RESEARCH_FIELDS.flatMap((field) => {
      const entry = row.fields[field];
      return entry ? [{ field, text: access.text(companyFieldText(entry.text)), source_url: readSourceUrl(httpsUrlOrNull(entry.sourceUrl), clean) }] : [];
    }),
  };
  return limitReadOutput(ctx, getCompanyOutputFor(ctx.permissions ?? new Set()), {
    notices: readNotices(ctx, jobs.length, page.total, limit, research?.available === false),
    total: page.total, returned: jobs.length, truncated: page.total > jobs.length,
    company: { id: company.id, name: clean(company.name), aliases: company.aliases.map(clean), website_domain: company.websiteDomain === null ? null : clean(company.websiteDomain), website_domain_source: company.websiteDomainSource === "user" || company.websiteDomainSource === "inferred" ? company.websiteDomainSource : null, ...marks, text_withheld: null },
    research, jobs,
  }, limit);
}

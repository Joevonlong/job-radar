import { z } from "zod";
import { MCP_MAX_RESULTS_CAP } from "@/lib/config/schemas/mcp";
import { companyOverviewDependencies } from "@/lib/companies/overview-data";
import { buildBlacklistedCompanyKeys, buildWatchedCompanyKeys, isCompanyExcluded, isCompanyWatched } from "@/lib/companies/marks";
import { getCompanyById } from "@/lib/db/repos/companies";
import { getCompanyResearchForJob } from "@/lib/db/repos/company-research";
import { listJobs } from "@/lib/db/queries/jobs";
import { readCompanyTexts } from "@/lib/db/queries/read-texts";
import { COMPANY_RESEARCH_FIELDS } from "@/lib/research/fields";
import { companyFieldText, httpsUrlOrNull } from "@/lib/writer/company-background";
import { ToolFailure, type McpContext } from "../context";
import { getCompanyOutput } from "../dto/companies";
import { readSourceUrl, readTextAccess } from "../read-guard";
import { resultLimit } from "./shared";
import { limitReadOutput, readCards, readNotices } from "./read-shared";

export function getCompanyInput(ctx: Pick<McpContext, "text">) {
  return z.strictObject({ company_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe(ctx.text("params.companyId")), limit: z.number().int().min(1).max(MCP_MAX_RESULTS_CAP).optional().describe(ctx.text("params.limit")) });
}
export async function getCompany(ctx: McpContext, args: z.infer<ReturnType<typeof getCompanyInput>>) {
  const company = await getCompanyById(ctx.db, args.company_id);
  if (company === null) throw new ToolFailure("not_found", ctx.text("errors.companyNotFound", { id: args.company_id }));
  const limit = resultLimit(ctx, args.limit);
  const texts = await readCompanyTexts(ctx.db, [company.id]);
  const access = await readTextAccess(ctx, texts);
  const settings = companyOverviewDependencies.loadSettings();
  const watched = isCompanyWatched(company, buildWatchedCompanyKeys(settings.watchedCompanies, settings.pipeline));
  const blacklisted = isCompanyExcluded(company, buildBlacklistedCompanyKeys(settings.excludedCompanies, settings.pipeline), settings.pipeline.company.legal_suffixes);
  const page = await listJobs(ctx.db, { filters: { companyIds: [company.id], statuses: ["active"], scope: "current" }, sort: "rank", page: 1, pageSize: limit, timezone: ctx.timezone(), visa: false, ghost: false });
  const jobs = await readCards(ctx, page.jobs);
  const row = texts[0] ? await getCompanyResearchForJob(ctx.db, texts[0].jobId, ctx.now()) : null;
  const research = row === null ? null : { available: access.reason === null, reason: access.reason, fetched_at: access.reason === null ? row.fetchedAt.toISOString() : null, expired: access.reason === null ? row.expired : null, fields: access.reason !== null ? [] : COMPANY_RESEARCH_FIELDS.flatMap((field) => { const entry = row.fields[field]; return entry ? [{ field, text: access.text(companyFieldText(entry.text)), source_url: readSourceUrl(httpsUrlOrNull(entry.sourceUrl), access) }] : []; }) };
  return limitReadOutput(ctx, getCompanyOutput, { notices: readNotices(ctx, jobs.length, page.total, limit, access.reason !== null), total: page.total, returned: jobs.length, truncated: page.total > jobs.length, company: { id: company.id, name: access.text(company.name), aliases: company.aliases.flatMap((alias) => { const text = access.text(alias); return text === null ? [] : [text]; }), website_domain: access.text(company.websiteDomain), website_domain_source: company.websiteDomainSource === "user" || company.websiteDomainSource === "inferred" ? company.websiteDomainSource : null, watched, blacklisted, text_withheld: access.reason }, research, jobs }, limit);
}

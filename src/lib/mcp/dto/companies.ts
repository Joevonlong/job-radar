import { z } from "zod";
import type { Permission } from "@/lib/agent-access/permissions";
import { notices, iso } from "./shared";
import { pageFields, readJobDto } from "./read-jobs";

/** Watched and blacklisted come from the owner's interests and preferences (profile data): released only with profile:read. */
const MARK_FIELDS = { watched: true, blacklisted: true } as const;
export const companyItemDto = z.strictObject({ id: z.number().int(), name: z.string().nullable(), watched: z.boolean(), blacklisted: z.boolean(), job_count: z.number().int(), top_rank: z.number().nullable(), last_first_seen_at: iso, text_withheld: z.string().nullable() });
/** The registered schemas accept both releases; each call is checked against the strict schema of its permissions. */
export const listCompaniesOutput = z.strictObject({ notices, ...pageFields, companies: z.array(companyItemDto.partial(MARK_FIELDS)) });
export const companyResearchDto = z.strictObject({ available: z.boolean(), reason: z.string().nullable(), fetched_at: iso.nullable(), expired: z.boolean().nullable(), fields: z.array(z.strictObject({ field: z.string(), text: z.string().nullable(), source_url: z.string().nullable() })) });
const companyDetailDto = z.strictObject({ id: z.number().int(), name: z.string().nullable(), aliases: z.array(z.string()), website_domain: z.string().nullable(), website_domain_source: z.enum(["user", "inferred"]).nullable(), watched: z.boolean(), blacklisted: z.boolean(), text_withheld: z.string().nullable() });
export const getCompanyOutput = z.strictObject({ notices, ...pageFields, company: companyDetailDto.partial(MARK_FIELDS), research: companyResearchDto.nullable(), jobs: z.array(readJobDto) });

export function listCompaniesOutputFor(permissions: ReadonlySet<Permission>): z.ZodType<z.infer<typeof listCompaniesOutput>> {
  return listCompaniesOutput.extend({ companies: z.array(permissions.has("profile:read") ? companyItemDto : companyItemDto.omit(MARK_FIELDS)) });
}

export function getCompanyOutputFor(permissions: ReadonlySet<Permission>): z.ZodType<z.infer<typeof getCompanyOutput>> {
  return getCompanyOutput.extend({ company: permissions.has("profile:read") ? companyDetailDto : companyDetailDto.omit(MARK_FIELDS) });
}

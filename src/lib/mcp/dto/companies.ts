import { z } from "zod";
import { notices, iso } from "./shared";
import { pageFields, readJobDto } from "./read-jobs";

export const companyItemDto = z.strictObject({ id: z.number().int(), name: z.string().nullable(), watched: z.boolean(), blacklisted: z.boolean(), job_count: z.number().int(), top_rank: z.number().nullable(), last_first_seen_at: iso, text_withheld: z.string().nullable() });
export const listCompaniesOutput = z.strictObject({ notices, ...pageFields, companies: z.array(companyItemDto) });
export const companyResearchDto = z.strictObject({ available: z.boolean(), reason: z.string().nullable(), fetched_at: iso.nullable(), expired: z.boolean().nullable(), fields: z.array(z.strictObject({ field: z.string(), text: z.string().nullable(), source_url: z.string().nullable() })) });
export const getCompanyOutput = z.strictObject({ notices, ...pageFields, company: z.strictObject({ id: z.number().int(), name: z.string().nullable(), aliases: z.array(z.string()), website_domain: z.string().nullable(), website_domain_source: z.enum(["user", "inferred"]).nullable(), watched: z.boolean(), blacklisted: z.boolean(), text_withheld: z.string().nullable() }), research: companyResearchDto.nullable(), jobs: z.array(readJobDto) });

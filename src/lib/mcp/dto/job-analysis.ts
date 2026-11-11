/** Job-derived blocks expose only cleaned content and public posting facts. */
import { z } from "zod";

import { REQUIREMENT_LEVELS, SPOKEN_LEVELS, TECH_CATEGORIES } from "@/lib/breakdown/constants";
import { GHOST_LEVELS } from "@/lib/ghost/types";

const date = z.iso.datetime({ offset: true });
const number = z.number().nullable();
const requirement = z.enum(REQUIREMENT_LEVELS);
const point = z.strictObject({ text: z.string(), requirement, quote: z.string().nullable(), offset: z.number().int() });

export const translationBlockDto = z.strictObject({
  available: z.boolean(),
  reason: z.string().nullable(),
  items: z.array(z.strictObject({ language: z.string(), text: z.string(), truncated: z.boolean(), total_chars: z.number().int(), stale: z.boolean(), created_at: date })),
});

export const breakdownBlockDto = z.strictObject({
  available: z.boolean(),
  reason: z.string().nullable(),
  content: z.strictObject({
    responsibilities: z.array(z.strictObject({ text: z.string(), quote: z.string().nullable(), offset: z.number().int() })),
    tech_stack: z.array(z.strictObject({ name: z.string(), category: z.enum(TECH_CATEGORIES), requirement, quote: z.string().nullable(), offset: z.number().int() })),
    experience: z.strictObject({ years_min: number, years_quote: z.strictObject({ quote: z.string().nullable(), offset: z.number().int() }).nullable(), items: z.array(point) }),
    projects: z.array(point),
    soft_skills: z.array(point),
    other: z.array(point),
    languages: z.array(z.strictObject({ language: z.string(), level: z.enum(SPOKEN_LEVELS), requirement, quote: z.string().nullable(), offset: z.number().int() })),
  }).nullable(),
  analyzed_at: date.nullable(),
});

const band = z.strictObject({ title: z.string(), seniority: z.string().nullable(), min: number, max: number, median: number, basis: z.enum(["base", "total", "unknown"]), location: z.string().nullable() });

export const salaryBlockDto = z.strictObject({
  currency: z.string(),
  figure: number,
  family: z.string().nullable(),
  benchmark: z.strictObject({ level: z.enum(["city", "country", "family_country", "family"]), seniority: z.string().nullable(), place: z.string().nullable(), n: z.number().int(), median: z.number(), quantiles: z.array(z.number()) }).nullable(),
  position: z.strictObject({ value: z.number(), clamp: z.enum(["below", "above"]).nullable() }).nullable(),
  company_figures: z.strictObject({ count: z.number().int(), median: number }).nullable(),
  lookup: z.strictObject({
    available: z.boolean(),
    reason: z.string().nullable(),
    fetched_at: date.nullable(),
    expired: z.boolean().nullable(),
    company_level: z.strictObject({ level: z.enum(["below", "market", "above", "top", "unknown"]), median: number, summary: z.string() }).nullable(),
    role_band: band.nullable(),
    related_roles: z.array(band).nullable(),
    sources: z.array(z.strictObject({ url: z.string().nullable(), host: z.string(), site: z.string(), title: z.string(), excerpt: z.string(), trusted: z.boolean() })).nullable(),
    confidence: z.enum(["low", "medium", "high"]).nullable(),
    notes: z.string().nullable(),
  }).nullable(),
}).nullable();

export const companyBlockDto = z.strictObject({
  available: z.boolean(),
  reason: z.string().nullable(),
  fetched_at: date.nullable(),
  expired: z.boolean().nullable(),
  fields: z.array(z.strictObject({ field: z.string(), text: z.string(), source_url: z.string().nullable() })),
}).nullable();

export const ghostReasonDto = z.discriminatedUnion("code", [
  z.strictObject({ code: z.literal("long_open"), points: z.number(), days: z.number().int(), since: z.iso.date(), from: z.enum(["posted", "first_seen"]), channel_id: z.string().nullable() }),
  z.strictObject({ code: z.literal("repost_label"), points: z.number(), channel_id: z.string(), label: z.string() }),
  z.strictObject({ code: z.literal("reposted"), points: z.number(), channel_id: z.string(), events: z.array(z.strictObject({ old_seen: z.iso.date(), new_seen: z.iso.date(), gap_days: z.number().int() })) }),
  z.strictObject({ code: z.literal("evergreen_wording"), points: z.number(), pattern_id: z.string(), quote: z.string().nullable(), offset: z.number().int(), field: z.literal("title").optional() }),
  z.strictObject({ code: z.literal("thin_description"), points: z.number(), words: z.number().int(), min_words: z.number().int(), has_responsibilities: z.boolean(), responsibilities_from: z.enum(["headings", "breakdown", "none"]), channel_id: z.string() }),
]);

export const ghostBlockDto = z.strictObject({ state: z.enum(["clear", "watch", "likely", "dismissed", "not_checked"]), level: z.enum(GHOST_LEVELS).nullable(), score: z.number(), checked_at: date.nullable(), dismissed: z.boolean(), reasons: z.array(ghostReasonDto) }).nullable();

export const lifecycleBlockDto = z.strictObject({ auto_status: z.enum(["active", "possibly_closed", "closed"]), closed_reason: z.enum(["manual", "gone", "dormant", "phrase", "possibly"]).nullable(), last_seen_at: date, last_listed_at: date.nullable(), relisted_at: date.nullable(), relist_count: z.number().int(), dormant: z.boolean() });

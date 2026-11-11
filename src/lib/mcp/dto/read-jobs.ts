import { z } from "zod";
import type { Permission } from "@/lib/agent-access/permissions";
import type { JobCard } from "@/lib/db/queries/types";
import { readSourceUrl } from "../read-guard";
import { iso, isoOrNull, notices, type CleanText } from "./shared";

export const readJobDto = z.strictObject({
  id: z.number().int(), title: z.string().nullable(), company: z.string().nullable(), status: z.string(),
  rank_value: z.number().nullable(), posted_at: iso.nullable(), first_seen_at: iso,
  locations: z.array(z.strictObject({ label: z.string().nullable(), city: z.string().nullable(), country_code: z.string().nullable() })),
  links: z.array(z.strictObject({ source: z.string().nullable(), url: z.string().nullable(), apply_url: z.string().nullable() })),
  text_withheld: z.string().nullable(),
});
export const pageFields = { total: z.number().int(), returned: z.number().int(), truncated: z.boolean() };
const quickCounts = z.strictObject({ all: z.number().int(), high: z.number().int(), salary: z.number().int(), following: z.number().int() });
/** The registered schema accepts both releases; each call is checked against the strict schema of its permissions. */
export const todayOutput = z.strictObject({ notices, ...pageFields, view: z.string().nullable(), quick: z.enum(["high", "salary", "following"]).nullable(), quick_counts: quickCounts.partial({ following: true }), jobs: z.array(readJobDto) });
/** The following count is tracking data: present exactly with tracking:read. */
export function todayOutputFor(permissions: ReadonlySet<Permission>): z.ZodType<z.infer<typeof todayOutput>> {
  return todayOutput.extend({ quick_counts: permissions.has("tracking:read") ? quickCounts : quickCounts.omit({ following: true }) });
}

export function toReadJobDto(card: JobCard, clean: CleanText) {
  const link = (url: string | null) => readSourceUrl(url, clean);
  return readJobDto.parse({ id: card.id, title: clean(card.title), company: clean(card.companyName), status: card.status, rank_value: card.rank?.rankValue ?? null, posted_at: isoOrNull(card.postedAt), first_seen_at: card.firstSeenAt.toISOString(),
    locations: card.locations.map((row) => ({ label: row.label === null ? null : clean(row.label), city: row.city === null ? null : clean(row.city), country_code: row.countryCode === null ? null : clean(row.countryCode) })),
    links: card.sources.map((row) => ({ source: clean(row.family), url: link(row.url), apply_url: link(row.applyUrl) })), text_withheld: null });
}

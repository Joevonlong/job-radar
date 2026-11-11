/** Derived posting and web text follows the JD's fail-closed rule before any stored content is released. */
import type { z } from "zod";

import { parseStoredBreakdown, type BreakdownContent } from "@/lib/breakdown/content";
import { getJobBreakdown } from "@/lib/db/repos/breakdowns";
import { getCompanyResearchForJob } from "@/lib/db/repos/company-research";
import { getTranslation } from "@/lib/db/repos/translations";
import { salaryContextInput } from "@/lib/jobs/detail-inputs";
import { buildGhostCheckView } from "@/lib/ghost/view";
import type { GhostReason } from "@/lib/ghost/types";
import type { McpContext } from "@/lib/mcp/context";
import { breakdownBlockDto, companyBlockDto, ghostBlockDto, ghostReasonDto, lifecycleBlockDto, salaryBlockDto, translationBlockDto } from "@/lib/mcp/dto/job-analysis";
import { isoOrNull } from "@/lib/mcp/dto/shared";
import { safeSourceUrl, truncateText } from "@/lib/mcp/guard";
import { COMPANY_RESEARCH_FIELDS } from "@/lib/research/fields";
import type { SalaryBand } from "@/lib/salary/lookup-types";
import { getSalaryContext } from "@/lib/salary/view";
import { isTranslationStale } from "@/lib/translation/hash";
import { companyFieldText, httpsUrlOrNull } from "@/lib/writer/company-background";

import { jobBlockSettings } from "./settings";
import { quotedText, type JobBlockSource } from "./source";

export async function loadTranslation(ctx: McpContext, source: JobBlockSource): Promise<z.infer<typeof translationBlockDto>> {
  if (!source.strict.ok) return { available: false, reason: source.strict.reason, items: [] };
  const rows = await Promise.all(source.detail.translatedLanguages.map((language) => getTranslation(ctx.db, source.detail.id, language)));
  return {
    available: true,
    reason: null,
    items: rows.flatMap((row) => {
      if (row === null) return [];
      const text = source.clean(row.content);
      const cut = truncateText(text, ctx.settings.limits.max_description_chars);
      return [{ language: source.clean(row.lang), text: cut.text, truncated: cut.truncated, total_chars: text.length, stale: isTranslationStale(row.sourceHash, source.detail.description), created_at: row.createdAt.toISOString() }];
    }),
  };
}

export function toBreakdownContent(content: BreakdownContent, source: JobBlockSource): NonNullable<z.infer<typeof breakdownBlockDto>["content"]> {
  const point = (item: { text: string; quote: string; offset: number }) => ({ ...quotedText(source, item.text, item.quote, item.offset), offset: item.offset });
  const requiredPoint = (item: BreakdownContent["other"][number]) => {
    const mapped = point(item);
    return { text: mapped.text, requirement: item.requirement, quote: mapped.quote, offset: mapped.offset };
  };
  return {
    responsibilities: content.responsibilities.map(point),
    tech_stack: content.tech_stack.map((item) => {
      const mapped = point({ text: item.name, quote: item.quote, offset: item.offset });
      return { name: mapped.text, category: item.category, requirement: item.requirement, quote: mapped.quote, offset: mapped.offset };
    }),
    experience: { years_min: content.experience.years_min, years_quote: content.experience.years_quote ? { quote: source.quote(content.experience.years_quote.quote, content.experience.years_quote.offset), offset: content.experience.years_quote.offset } : null, items: content.experience.items.map(requiredPoint) },
    projects: content.projects.map(requiredPoint),
    soft_skills: content.soft_skills.map(requiredPoint),
    other: content.other.map(requiredPoint),
    languages: content.languages.map((item) => {
      const mapped = quotedText(source, item.language, item.quote, item.offset);
      return { language: mapped.text, level: item.level, requirement: item.requirement, quote: mapped.quote, offset: item.offset };
    }),
  };
}

export async function loadBreakdown(ctx: McpContext, source: JobBlockSource): Promise<z.infer<typeof breakdownBlockDto>> {
  if (!source.strict.ok) return { available: false, reason: source.strict.reason, content: null, analyzed_at: null };
  const row = await getJobBreakdown(ctx.db, source.detail.id);
  const content = row ? parseStoredBreakdown(row.promptVersion, row.content) : null;
  return { available: content !== null, reason: null, content: content ? toBreakdownContent(content, source) : null, analyzed_at: row && content ? row.analyzedAt.toISOString() : null };
}

export async function loadCompany(ctx: McpContext, source: JobBlockSource): Promise<z.infer<typeof companyBlockDto>> {
  const row = await getCompanyResearchForJob(ctx.db, source.detail.id, ctx.now());
  if (row === null) return null;
  if (!source.strict.ok) return { available: false, reason: source.strict.reason, fetched_at: null, expired: null, fields: [] };
  return {
    available: true,
    reason: null,
    fetched_at: row.fetchedAt.toISOString(),
    expired: row.expired,
    fields: COMPANY_RESEARCH_FIELDS.flatMap((field) => {
      const entry = row.fields[field];
      return entry ? [{ field, text: source.clean(companyFieldText(entry.text)), source_url: safeSourceUrl(httpsUrlOrNull(entry.sourceUrl), source.clean) }] : [];
    }),
  };
}

export async function loadSalary(ctx: McpContext, source: JobBlockSource): Promise<z.infer<typeof salaryBlockDto>> {
  const settings = jobBlockSettings();
  const currency = settings.baseCurrency() ?? "";
  const value = await getSalaryContext(ctx.db, salaryContextInput(source.detail, { currency, salary: settings.salary(), ai: settings.ai(), locale: ctx.text.locale ?? "en", now: ctx.now() }));
  if (value === null) return null;
  const { clean } = source;
  const text = (value: string | null) => value === null ? null : clean(value);
  const band = (value: SalaryBand) => ({ title: clean(value.title), seniority: text(value.seniority), min: value.min, max: value.max, median: value.median, basis: value.basis, location: text(value.location) });
  const latest = value.lookup.latest;
  const lookup: NonNullable<z.infer<typeof salaryBlockDto>>["lookup"] = latest === null ? null : !source.strict.ok
    ? { available: false, reason: source.strict.reason, fetched_at: null, expired: null, company_level: null, role_band: null, related_roles: null, sources: null, confidence: null, notes: null }
    : { available: true, reason: null, fetched_at: latest.fetchedAt, expired: latest.expired, company_level: { level: latest.result.companyLevel.level, median: latest.result.companyLevel.median, summary: clean(latest.result.companyLevel.summary) }, role_band: latest.result.roleBand ? band(latest.result.roleBand) : null, related_roles: latest.result.relatedRoles.map(band), sources: latest.result.sources.map((entry) => ({ url: safeSourceUrl(entry.url, clean), host: clean(entry.host), site: clean(entry.site), title: clean(entry.title), excerpt: clean(entry.excerpt), trusted: entry.trusted })), confidence: latest.result.confidence, notes: clean(latest.result.notes) };
  return {
    currency: clean(value.currency),
    figure: value.figure,
    family: text(value.familyId),
    benchmark: value.group ? { level: value.group.level, seniority: text(value.group.seniority), place: text(value.group.place), n: value.group.n, median: value.group.median, quantiles: value.group.quantiles.map((number) => number) } : null,
    position: value.position ? { value: value.position.value, clamp: value.position.clamp } : null,
    company_figures: value.company ? { count: value.company.count, median: value.company.median } : null,
    lookup,
  };
}

export function toGhostReason(reason: GhostReason, source: JobBlockSource): z.infer<typeof ghostReasonDto> {
  switch (reason.code) {
    case "long_open": return { code: reason.code, points: reason.points, days: reason.days, since: reason.since, from: reason.from, channel_id: reason.channelId === null ? null : source.clean(reason.channelId) };
    case "repost_label": return { code: reason.code, points: reason.points, channel_id: source.clean(reason.channelId), label: source.clean(reason.label) };
    case "reposted": return { code: reason.code, points: reason.points, channel_id: source.clean(reason.channelId), events: reason.events.map((event) => ({ old_seen: event.oldSeen, new_seen: event.newSeen, gap_days: event.gapDays })) };
    case "evergreen_wording": return { code: reason.code, points: reason.points, pattern_id: source.clean(reason.patternId), quote: reason.field === "title" ? source.clean(reason.quote) : source.quote(reason.quote, reason.offset), offset: reason.offset, ...(reason.field ? { field: reason.field } : {}) };
    case "thin_description": return { code: reason.code, points: reason.points, words: reason.words, min_words: reason.minWords, has_responsibilities: reason.hasResponsibilities, responsibilities_from: reason.responsibilitiesFrom, channel_id: source.clean(reason.channelId) };
  }
}

export async function loadGhost(_ctx: McpContext, source: JobBlockSource): Promise<z.infer<typeof ghostBlockDto>> {
  if (!jobBlockSettings().ghostEnabled()) return null;
  const view = buildGhostCheckView(source.detail.ghost);
  return { state: view.state, level: view.level, score: view.score, checked_at: isoOrNull(source.detail.ghost?.checkedAt ?? null), dismissed: source.detail.ghost?.dismissed ?? false, reasons: view.reasons.map((reason) => toGhostReason(reason, source)) };
}

export async function loadLifecycle(_ctx: McpContext, { detail }: JobBlockSource): Promise<z.infer<typeof lifecycleBlockDto>> {
  return { auto_status: detail.closure.autoStatus, closed_reason: detail.closure.reason, last_seen_at: detail.lastSeenAt.toISOString(), last_listed_at: isoOrNull(detail.lastListedAt), relisted_at: isoOrNull(detail.relistedAt), relist_count: detail.relistCount, dormant: detail.closure.reason === "dormant" };
}

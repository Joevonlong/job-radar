/** Personal reads are explicit allow-lists; page metadata and stored row internals never cross this boundary. */
import { z } from "zod";

import type { InterestSuggestion } from "@/lib/db/repos/interest-suggestions";
import type { PersonalInterestsData } from "@/lib/interests/view";
import { suggestionPayloadSchema, type SuggestionPayload } from "@/lib/interests/suggestion";
import type { CategoryPreview } from "@/lib/interests/preview";
import type { CategoryDraft } from "@/lib/interests/vocabulary-draft";
import type { MeDraft, PreferencesDraft, DealBreakerDraft } from "@/lib/profile/draft";
import type { previewPersonalDealBreakers } from "@/lib/profile/deal-breaker-preview";
import type { StoriesDraft } from "@/lib/stories/draft";

import type { CleanText } from "./shared";

const strings = z.array(z.string());
const notices = strings;
const dealBreakerDto = z.strictObject({ id: z.string(), label: z.string(), enabled: z.boolean(), type: z.string(), at_least: z.string(), terms: strings, patterns: strings, scope: z.string(), unless: strings });
const meDto = z.strictObject({
  languages: z.array(z.strictObject({ code: z.string(), level: z.string() })),
  skills: z.array(z.strictObject({ name: z.string(), years: z.string() })),
  years_experience: z.string(), city: z.string(), needs_visa_sponsorship: z.boolean(), summary: z.string(),
});
const preferencesDto = z.strictObject({
  market: z.strictObject({ pack: z.string(), country: z.string(), currency: z.string(), home_language: z.string() }),
  target_titles: strings, home_city: z.string(), home_city_id: z.number().nullable(),
  places: z.array(z.strictObject({ place: z.string(), relocate: z.boolean(), id: z.union([z.number(), z.string()]).nullable() })),
  workplace: strings, seniority: z.string(), salary_floor_year: z.string(),
  contracts: z.strictObject({ permanent: z.string(), fixed_term: z.string(), freelance: z.string(), temp_agency: z.string() }),
  exclude_student_roles: z.boolean(), exclude_companies: strings, exclude_keywords: strings, deal_breakers: z.array(dealBreakerDto),
});
const storyDto = z.strictObject({ id: z.string(), title: z.string(), what: z.string(), result: z.string(), metrics: strings, skills: strings, period: z.string(), language: z.string(), tags: strings, source: z.string() });
export const getProfileOutput = z.strictObject({
  notices,
  me: z.strictObject({ baseHash: z.string(), data: meDto }).optional(),
  preferences: z.strictObject({ baseHash: z.string(), data: preferencesDto }).optional(),
  stories: z.strictObject({ baseHash: z.string(), data: z.strictObject({ stories: z.array(storyDto) }) }).optional(),
});
export type GetProfileOutput = z.infer<typeof getProfileOutput>;

export function toMeDto(d: MeDraft): z.infer<typeof meDto> {
  return { languages: d.languages.map((v) => ({ code: v.code, level: v.level })), skills: d.skills.map((v) => ({ name: v.name, years: v.years })), years_experience: d.years_experience, city: d.city, needs_visa_sponsorship: d.needs_visa_sponsorship, summary: d.summary };
}
function toDealBreakerDto(d: DealBreakerDraft) {
  return { id: d.id, label: d.label, enabled: d.enabled, type: d.type, at_least: d.at_least, terms: [...d.terms], patterns: [...d.patterns], scope: d.scope, unless: [...d.unless] };
}
export function toPreferencesDto(d: PreferencesDraft): z.infer<typeof preferencesDto> {
  return {
    market: { pack: d.market.pack, country: d.market.country, currency: d.market.currency, home_language: d.market.home_language },
    target_titles: [...d.target_titles], home_city: d.home_city, home_city_id: d.home_city_id ?? null,
    places: d.places.map((v) => ({ place: v.place, relocate: v.relocate, id: v.id ?? null })), workplace: [...d.workplace], seniority: d.seniority, salary_floor_year: d.salary_floor_year,
    contracts: { permanent: d.contracts.permanent, fixed_term: d.contracts.fixed_term, freelance: d.contracts.freelance, temp_agency: d.contracts.temp_agency },
    exclude_student_roles: d.exclude_student_roles, exclude_companies: [...d.exclude_companies], exclude_keywords: [...d.exclude_keywords], deal_breakers: d.deal_breakers.map(toDealBreakerDto),
  };
}
export function toStoriesDto(d: StoriesDraft) {
  return { stories: d.stories.map((s) => ({ id: s.id, title: s.title, what: s.what, result: s.result, metrics: [...s.metrics], skills: [...s.skills], period: s.period, language: s.language, tags: [...s.tags], source: s.source })) };
}

const categoryDto = z.strictObject({ id: z.string(), kind: z.string(), labelZh: z.string(), labelEn: z.string(), icon: z.string(), color: z.string(), weight: z.string(), highValue: z.boolean(), aiConfirmOnly: z.boolean(), aiDefinition: z.string(), keywords: strings, patterns: strings, exclude: strings, tags: strings, tagPatterns: z.array(z.strictObject({ name: z.string(), pattern: z.string() })) });
const oneOrMany = z.union([z.string(), strings]);
const filtersDto = z.strictObject({
  q: z.string().optional(), source: oneOrMany.optional(), city: oneOrMany.optional(), company: strings.optional(), workplace: oneOrMany.optional(), contract: oneOrMany.optional(), status: oneOrMany.optional(), app: strings.optional(),
  minScore: z.number().optional(), minSalary: z.number().optional(), from: z.string().optional(), to: z.string().optional(), within: z.string().optional(), dateBy: z.string().optional(),
  salary: z.boolean().optional(), filtered: z.boolean().optional(), hideLang: z.boolean().optional(), high: z.boolean().optional(), trap: z.string().optional(), visa: z.string().optional(), ghost: z.string().optional(),
});
const evidenceDto = z.strictObject({ jobId: z.number(), title: z.string(), company: z.string(), quote: z.string().optional() });
const suggestionCommon = { reasons: z.record(z.string(), z.string()), confidence: z.number(), evidence: z.array(evidenceDto) };
const suggestionDto = z.strictObject({ id: z.number(), createdAt: z.string(), payload: z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("signal_word"), tier: z.string(), term: z.string(), ...suggestionCommon }),
  z.strictObject({ kind: z.literal("watched_company"), company: z.string(), ...suggestionCommon }),
  z.strictObject({ kind: z.literal("filter"), action: z.enum(["exclude_keyword", "add_location", "exclude_company"]), value: z.string(), ...suggestionCommon }),
]).nullable() });
export const getInterestsOutput = z.strictObject({
  notices,
  vocabulary: z.strictObject({ categories: z.array(categoryDto), retired: z.array(categoryDto), bonusCap: z.string() }),
  views: z.array(z.strictObject({ id: z.string(), name: z.string(), default: z.boolean(), filters: filtersDto })),
  watched_companies: strings,
  pending_suggestions: z.array(suggestionDto), total: z.number(), returned: z.number(), truncated: z.boolean(),
});
export type GetInterestsOutput = z.infer<typeof getInterestsOutput>;

function toCategoryDto(c: CategoryDraft) {
  return { id: c.id, kind: c.kind, labelZh: c.labelZh, labelEn: c.labelEn, icon: c.icon, color: c.color, weight: c.weight, highValue: c.highValue, aiConfirmOnly: c.aiConfirmOnly, aiDefinition: c.aiDefinition, keywords: [...c.keywords], patterns: [...c.patterns], exclude: [...c.exclude], tags: [...c.tags], tagPatterns: c.tagPatterns.map((p) => ({ name: p.name, pattern: p.pattern })) };
}
export function toInterestSettingsDto(page: Pick<PersonalInterestsData, "vocabulary" | "views" | "watched">) {
  if (!page.vocabulary) throw new Error("unavailable");
  const d = page.vocabulary.draft;
  return {
    vocabulary: { categories: d.categories.map(toCategoryDto), retired: d.retired.map(toCategoryDto), bonusCap: d.bonusCap },
    views: page.views.map((v) => {
      const f = v.filters;
      return { id: v.id, name: v.name, default: v.default, filters: { q: f.q, source: f.source, city: f.city, company: f.company, workplace: f.workplace, contract: f.contract, status: f.status, app: f.app, minScore: f.minScore, minSalary: f.minSalary, from: f.from, to: f.to, within: f.within, dateBy: f.dateBy, salary: f.salary, filtered: f.filtered, hideLang: f.hideLang, high: f.high, trap: f.trap, visa: f.visa, ghost: f.ghost } };
    }),
    watched_companies: page.watched.map((c) => c.name),
  };
}
function toSuggestionPayload(p: SuggestionPayload, clean: CleanText) {
  const common = { reasons: Object.fromEntries(Object.entries(p.reasons).map(([lang, reason]) => [lang, clean(reason)])), confidence: p.confidence, evidence: p.evidence.map((e) => ({ jobId: e.jobId, title: clean(e.title), company: clean(e.company), ...(e.quote === undefined ? {} : { quote: clean(e.quote) }) })) };
  switch (p.kind) {
    case "signal_word": return { kind: p.kind, tier: p.tier, term: clean(p.term), ...common };
    case "watched_company": return { kind: p.kind, company: clean(p.company), ...common };
    case "filter": return { kind: p.kind, action: p.action, value: clean(p.value), ...common };
  }
}
export function toSuggestionDto(row: InterestSuggestion, clean: CleanText) {
  const payload = suggestionPayloadSchema.safeParse(row.payloadJson);
  return { id: row.id, createdAt: row.createdAt.toISOString(), payload: payload.success ? toSuggestionPayload(payload.data, clean) : null };
}

export const previewDealBreakersOutput = z.strictObject({ notices, total: z.number(), partial: z.boolean(), rules: z.array(z.strictObject({ id: z.string(), status: z.string(), count: z.number(), ms: z.number(), samples: z.array(z.strictObject({ jobId: z.number(), title: z.string(), company: z.string(), quote: z.string().nullable().optional() })) })) });
export function toDealBreakerPreviewDto(p: Awaited<ReturnType<typeof previewPersonalDealBreakers>>, clean: CleanText) {
  return { total: p.total, partial: p.partial, rules: p.rules.map((r) => ({ id: r.id, status: r.status, count: r.count, ms: r.ms, samples: r.samples.map((s) => ({ jobId: s.jobId, title: clean(s.title), company: clean(s.company), ...(s.quote === undefined ? {} : { quote: s.quote === null ? null : clean(s.quote) }) })) })) };
}
const categoryPreviewDto = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), scanned: z.number(), truncated: z.boolean(), hits: z.number(), samples: z.array(z.strictObject({ jobId: z.number(), title: z.string(), quote: z.string() })), review: z.strictObject({ jobs: z.number(), rounds: z.number().nullable(), perCycleLimit: z.number().nullable() }).nullable() }),
  z.strictObject({ status: z.literal("invalid"), fieldErrors: z.array(z.strictObject({ path: z.string(), key: z.string(), params: z.record(z.string(), z.union([z.string(), z.number()])).optional() })) }),
  z.strictObject({ status: z.literal("invalidPayload") }), z.strictObject({ status: z.literal("unavailable") }),
]);
export const previewInterestCategoryOutput = z.strictObject({ notices, preview: categoryPreviewDto });
export function toCategoryPreviewDto(p: CategoryPreview, clean: CleanText): z.infer<typeof categoryPreviewDto> {
  switch (p.status) {
    case "ok": return { status: p.status, scanned: p.scanned, truncated: p.truncated, hits: p.hits, samples: p.samples.map((s) => ({ jobId: s.jobId, title: clean(s.title), quote: clean(s.quote) })), review: p.review === null ? null : { jobs: p.review.jobs, rounds: p.review.rounds, perCycleLimit: p.review.perCycleLimit } };
    case "invalid": return { status: p.status, fieldErrors: p.fieldErrors.map((e) => ({ path: e.path, key: e.key, ...(e.params === undefined ? {} : { params: e.params }) })) };
    default: return { status: p.status };
  }
}

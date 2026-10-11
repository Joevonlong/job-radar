/**
 * What a stored interest suggestion looks like. `interest_suggestions.payload_json` is parsed with
 * these schemas wherever it is read (the page, the approval), so a row that does not fit is shown as unreadable
 * instead of crashing anything (C6). Pure: shared by the server code and the client components.
 */
import { z } from "zod";

/**
 * Where a signal word goes: the id of a keyword or tag category of interests.yaml. Suggestions stored before
 * Older versions say `benefit_tag` for the benefit tags: read as the first tag category (`suggestedCategoryId`).
 */
export const LEGACY_BENEFIT_TAG = "benefit_tag";
const suggestedTierSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,23}$/);

/** The category a signal word suggestion goes into: its id, `benefit_tag` = the first tag category; null when there is none. */
export function suggestedCategoryId(tier: string, categories: ReadonlyArray<{ id: string; kind: string }>): string | null {
  if (tier === LEGACY_BENEFIT_TAG) return categories.find((category) => category.kind === "tag")?.id ?? null;
  return categories.some((category) => category.id === tier) ? tier : null;
}

/** What a filter suggestion changes in preferences.yaml. */
export const FILTER_ACTIONS = ["exclude_keyword", "add_location", "exclude_company"] as const;
export type FilterAction = (typeof FILTER_ACTIONS)[number];

export const SUGGESTION_KINDS = ["signal_word", "watched_company", "filter"] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

/** A job that backs a suggestion. `quote` is verbatim JD text (vocabulary suggestions always have one). */
const evidenceSchema = z.strictObject({
  jobId: z.number().int().positive(),
  title: z.string(),
  company: z.string(),
  quote: z.string().optional(),
});
export type SuggestionEvidence = z.infer<typeof evidenceSchema>;

const common = {
  /** One sentence per language (`ai.output` and `ai.summary_also` when the suggestion was made): language -> text. */
  reasons: z.record(z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/), z.string()).refine((reasons) => Object.values(reasons).some((text) => text.trim() !== ""), "needs a reason"),
  /** 0 to 1, as the AI stated it. */
  confidence: z.number().min(0).max(1),
  evidence: z.array(evidenceSchema).min(1),
};

const signalWordSchema = z.strictObject({ kind: z.literal("signal_word"), tier: suggestedTierSchema, term: z.string().min(1), ...common });
const watchedCompanySchema = z.strictObject({ kind: z.literal("watched_company"), company: z.string().min(1), ...common });
const filterSchema = z.strictObject({ kind: z.literal("filter"), action: z.enum(FILTER_ACTIONS), value: z.string().min(1), ...common });

/**
 * A payload stored before the reasons became per language has `reasonZh` / `reasonEn`; it is read as `reasons`
 * (`{ zh, en }`, empty ones left out). The stored rows are not rewritten.
 */
export function upgradeLegacyReasons(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value) || "reasons" in value) return value;
  const { reasonZh, reasonEn, ...rest } = value as Record<string, unknown>;
  if (reasonZh === undefined && reasonEn === undefined) return value;
  const reasons: Record<string, string> = {};
  if (typeof reasonZh === "string" && reasonZh.trim() !== "") reasons.zh = reasonZh;
  if (typeof reasonEn === "string" && reasonEn.trim() !== "") reasons.en = reasonEn;
  return { ...rest, reasons };
}

export const suggestionPayloadSchema = z.preprocess(upgradeLegacyReasons, z.discriminatedUnion("kind", [signalWordSchema, watchedCompanySchema, filterSchema]));
export type SuggestionPayload = z.output<typeof suggestionPayloadSchema>;
export type SignalWordSuggestion = z.infer<typeof signalWordSchema>;
export type WatchedCompanySuggestion = z.infer<typeof watchedCompanySchema>;
export type FilterSuggestion = z.infer<typeof filterSchema>;

/** Case, accents' width and spacing folded: "Stock  Options" and "stock options" are the same suggestion. */
export function normalizeTerm(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

/**
 * The identity of a suggestion, whatever its status: the same word is never proposed twice, even for another
 * tier (it was already answered). Companies are keyed by their normalized name, so spellings join.
 */
export function dedupeKeyOf(payload: SuggestionPayload, normalizeCompany: (name: string) => string): string {
  switch (payload.kind) {
    case "signal_word":
      return `signal_word:${normalizeTerm(payload.term)}`;
    case "watched_company":
      return `watched_company:${normalizeCompany(payload.company)}`;
    case "filter":
      return `filter:${payload.action}:${payload.action === "exclude_company" ? normalizeCompany(payload.value) : normalizeTerm(payload.value)}`;
  }
}

/** The text that is added to a list when the suggestion is approved. */
export function suggestedValue(payload: SuggestionPayload): string {
  switch (payload.kind) {
    case "signal_word":
      return payload.term;
    case "watched_company":
      return payload.company;
    case "filter":
      return payload.value;
  }
}

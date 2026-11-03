/**
 * The check of an extracted draft, in code and without another AI call: every field must quote the source, and every figure
 * of its value must be in that quote. It runs on the ai-worker while the source is still at hand. A field that fails is
 * flagged, not dropped: you decide. A passed check means the quote was found, not that the value is a fair reading of it.
 */
import type { WriterConfig } from "@/lib/config";
import { locateQuote } from "@/lib/signals/quote";
import { figures } from "@/lib/writer/verify";

import type { StoredExtractField, StoredStoryDraft } from "./extract";

export interface ExtractedField {
  value: string;
  quote: string;
}

export interface ExtractedDraft {
  title: ExtractedField;
  what: ExtractedField;
  result?: ExtractedField | null | undefined;
  period?: ExtractedField | null | undefined;
  metrics: readonly ExtractedField[];
  skills: readonly ExtractedField[];
  language?: string | null | undefined;
}

type EvidenceConfig = Pick<WriterConfig["evidence"], "min_quote_chars" | "figure_units">;

/** The check of one field. The stored quote is the source's own text (whitespace as the source has it). */
export function verifyExtractField(source: string, field: ExtractedField, config: EvidenceConfig): StoredExtractField {
  const value = field.value.trim();
  const found = locateQuote(source, field.quote);
  if (!found) return { value, quote: field.quote.trim(), flag: "quote_missing", missing: [] };
  const short = found.quote.length < config.min_quote_chars && found.quote !== value;
  if (short) return { value, quote: found.quote, flag: "quote_too_short", missing: [] };
  const inValue = figures(value, config.figure_units);
  const inQuote = figures(found.quote, config.figure_units);
  const missing = [...inValue.keys].filter((key) => !inQuote.keys.has(key));
  if (missing.length > 0) return { value, quote: found.quote, flag: "figure_missing", missing: inValue.shown.length > 0 ? inValue.shown.filter((shown) => missing.some((key) => figures(shown, config.figure_units).keys.has(key))) : missing };
  return { value, quote: found.quote, flag: null, missing: [] };
}

/** Lowercase ISO language code, or nothing: an unusable code must not block adopting the draft. */
function languageOf(language: string | null | undefined): string | null {
  const code = language?.trim().toLowerCase() ?? "";
  return /^[a-z]{2,3}$/.test(code) ? code : null;
}

export interface ExtractLimits {
  titleMaxChars: number;
  textMaxChars: number;
  listMaxItems: number;
}

function clip(field: ExtractedField, max: number): ExtractedField {
  return { ...field, value: field.value.trim().slice(0, max) };
}

/**
 * The stored form of one draft, every field checked against the source. Longer values than a story may hold are cut (a figure
 * cut away is simply not there), so a draft can always be adopted as it stands. Empty optional fields and duplicate entries go.
 */
export function verifyExtractedDraft(source: string, draft: ExtractedDraft, config: EvidenceConfig, limits: ExtractLimits): StoredStoryDraft {
  const check = (field: ExtractedField, max: number) => verifyExtractField(source, clip(field, max), config);
  const optional = (field: ExtractedField | null | undefined, max: number) => (field && field.value.trim() !== "" ? check(field, max) : null);
  const list = (fields: readonly ExtractedField[]): StoredExtractField[] => {
    const seen = new Set<string>();
    return fields
      .filter((field) => {
        const key = field.value.trim().toLowerCase();
        if (key === "" || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limits.listMaxItems)
      .map((field) => check(field, limits.titleMaxChars));
  };
  return {
    title: check(draft.title, limits.titleMaxChars),
    what: check(draft.what, limits.textMaxChars),
    result: optional(draft.result, limits.textMaxChars),
    period: optional(draft.period, limits.titleMaxChars),
    metrics: list(draft.metrics),
    skills: list(draft.skills),
    language: languageOf(draft.language),
  };
}

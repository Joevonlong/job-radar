/**
 * The one-line AI summary of a score row per language. `scores.summaries` holds them (language -> text); a row
 * written before the language settings (or by older code during a deploy) only has the old `summary_zh` / `summary_en` columns, which are
 * read as the `zh` / `en` entries. Pure.
 */
import { z } from "zod";

const summariesSchema = z.record(z.string(), z.string());

export interface SummaryColumns {
  summaries: unknown;
  summaryZh: string | null;
  summaryEn: string | null;
}

/** The non-empty summaries of a row, trimmed; the old columns when `summaries` is empty. */
export function summariesOf(row: SummaryColumns): Record<string, string> {
  const parsed = summariesSchema.safeParse(row.summaries);
  const stored = parsed.success ? parsed.data : {};
  const legacy: Record<string, string | null> = { zh: row.summaryZh, en: row.summaryEn };
  const source = Object.keys(stored).length > 0 ? stored : legacy;
  const out: Record<string, string> = {};
  for (const [lang, text] of Object.entries(source)) {
    const trimmed = text?.trim() ?? "";
    if (trimmed !== "") out[lang] = trimmed;
  }
  return out;
}

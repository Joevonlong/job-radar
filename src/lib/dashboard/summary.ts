/**
 * Which AI text to show. A score carries one-line summaries per language (`scores.summaries`) and reasons / gaps in
 * one language (`scores.output_lang`). The page shows the summary in the interface language when there is one, else in
 * the AI's output language, else English, else any; text not in the interface language is marked, never translated.
 */
import { FALLBACK } from "@/i18n/locale";
import type { JobCard } from "@/lib/db/queries/types";
import { sameLanguage } from "@/lib/i18n/languages";

export interface PickedSummary {
  text: string;
  /** The language the text is in (a key of the summaries). */
  lang: string;
  /** The text is not in the interface language: the page marks it. */
  fallback: boolean;
}

/** Preference order of the summary languages: the interface language, the AI's output language, English; no repeats. */
export function summaryOrder(uiLocale: string, outputLang: string | null): string[] {
  const order: string[] = [];
  for (const lang of [uiLocale, outputLang, FALLBACK]) if (lang && !order.some((known) => sameLanguage(known, lang))) order.push(lang);
  return order;
}

/** The first summary of `order` that exists (same primary language counts), else any one; null when there is none. */
export function pickSummary(summaries: Readonly<Record<string, string>> | null, order: readonly string[]): PickedSummary | null {
  if (summaries === null) return null;
  const entries = Object.entries(summaries).filter(([, text]) => text.trim() !== "");
  if (entries.length === 0) return null;
  const wanted = order[0];
  for (const lang of order) {
    const hit = entries.find(([key]) => sameLanguage(key, lang));
    if (hit) return { text: hit[1].trim(), lang: hit[0], fallback: !sameLanguage(hit[0], wanted) };
  }
  const [lang, text] = entries[0] as [string, string];
  return { text: text.trim(), lang, fallback: !sameLanguage(lang, wanted) };
}

/** Whether AI text in `outputLang` needs a language mark in this interface language (a different language, or unknown). */
export function needsLanguageTag(outputLang: string | null, uiLocale: string): boolean {
  return outputLang !== null && !sameLanguage(outputLang, uiLocale);
}

/** The AI summary of a list row (`JobCard.summary`) in the best language for `locale`; null when the job has none. */
export function pickListSummary(summary: JobCard["summary"], locale: string): string | null {
  if (!summary) return null;
  return pickSummary(summary.texts, summaryOrder(locale, summary.outputLang))?.text ?? null;
}

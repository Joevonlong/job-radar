import type { AtsTitlePrefilterSettings } from "@/lib/config";

import { compileTermMatcher } from "../ats/prefilter";

/** Candidate selection shared by the job-board channels. */

/**
 * Title filter of one query. A board search is a loose match (it also returns "similar" jobs), so a
 * title is kept when it contains a keyword of the query or an `include_terms` entry, and is never
 * kept when it contains an `exclude_terms` entry. Matching is whole-word and case-insensitive.
 */
export function createTitleFilter(settings: AtsTitlePrefilterSettings, keywords: readonly string[]): (title: string) => boolean {
  if (!settings.enabled) return () => true;
  const keep = compileTermMatcher([...keywords, ...settings.include_terms]);
  const drop = compileTermMatcher(settings.exclude_terms);
  return (title) => !(drop?.test(title) ?? false) && (keep?.test(title) ?? false);
}

/** Start of the look-back window. */
export function windowCutoff(now: Date, windowHours: number): Date {
  return new Date(now.getTime() - windowHours * 3_600_000);
}

/** Within the window? A posting without a usable date is kept: only a known old date drops it. */
export function isWithinWindow(date: Date | null, cutoff: Date): boolean {
  return date === null || date.getTime() >= cutoff.getTime();
}

export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Items of the lists merged without duplicates, taking one from each list in turn until `limit`. */
export function interleave<T>(lists: readonly (readonly T[])[], limit: number, idOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (let i = 0; out.length < limit; i += 1) {
    let any = false;
    for (const list of lists) {
      const item = list[i];
      if (item === undefined) continue;
      any = true;
      const id = idOf(item);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(item);
      if (out.length >= limit) break;
    }
    if (!any) break;
  }
  return out;
}

/** Plain-text slug of a search term for a URL path: lower case, words joined by "-". */
export function slugify(term: string): string {
  return term
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

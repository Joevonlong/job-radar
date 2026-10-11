import { createHash } from "node:crypto";

import type { AtsTitlePrefilterSettings } from "@/lib/config";

/**
 * Title prefilter of the ATS channels. A board returns every open posting; only titles that
 * match a search.yaml keyword (or an `include_terms` entry) are stored, plus everything of a watched
 * company. Terms match whole words, case-insensitively, with any run of spaces / hyphens between the
 * words of a term ("KI-Entwickler" also matches "KI Entwickler").
 */

export type PrefilterReason = "disabled" | "watched" | "keyword" | "include_term" | "excluded" | "no_match";

export interface PrefilterDecision {
  keep: boolean;
  reason: PrefilterReason;
}

export interface TitlePrefilterInput {
  settings: AtsTitlePrefilterSettings;
  /** `search.yaml: keyword_groups`. */
  keywordGroups: Readonly<Record<string, readonly string[]>>;
  /** `interests.yaml: watched_companies` (company names). */
  watchedCompanies: readonly string[];
}

export interface TitlePrefilter {
  /** Hash of everything that decides what is kept for `companyName` (changes when the config does). */
  fingerprint(companyName: string): string;
  decide(title: string, companyName: string): PrefilterDecision;
}

const WORD_CHAR = String.raw`[\p{L}\p{N}]`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, String.raw`\$&`);
}

function termSource(term: string): string {
  return term
    .trim()
    .split(/[\s\-‐-―]+/u)
    .filter((word) => word !== "")
    .map(escapeRegExp)
    .join(String.raw`[\s\-‐-―]+`);
}

/** One whole-word, case-insensitive matcher for a list of terms; null for an empty list. */
export function compileTermMatcher(terms: readonly string[]): RegExp | null {
  const sources = [...new Set(terms.map(termSource).filter((s) => s !== ""))];
  if (sources.length === 0) return null;
  return new RegExp(`(?<!${WORD_CHAR})(?:${sources.join("|")})(?!${WORD_CHAR})`, "iu");
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

export function createTitlePrefilter(input: TitlePrefilterInput): TitlePrefilter {
  const { settings } = input;
  const keywords = [...new Set(Object.values(input.keywordGroups).flat())].sort();
  const keywordMatcher = compileTermMatcher(keywords);
  const includeMatcher = compileTermMatcher(settings.include_terms);
  const excludeMatcher = compileTermMatcher(settings.exclude_terms);
  const watched = new Set(input.watchedCompanies.map(normalizeName));

  return {
    fingerprint(companyName) {
      const canonical = JSON.stringify([
        settings.enabled,
        keywords,
        [...settings.include_terms].sort(),
        [...settings.exclude_terms].sort(),
        watched.has(normalizeName(companyName)),
      ]);
      return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
    },
    decide(title, companyName) {
      if (!settings.enabled) return { keep: true, reason: "disabled" };
      if (watched.has(normalizeName(companyName))) return { keep: true, reason: "watched" };
      if (excludeMatcher?.test(title)) return { keep: false, reason: "excluded" };
      if (keywordMatcher?.test(title)) return { keep: true, reason: "keyword" };
      if (includeMatcher?.test(title)) return { keep: true, reason: "include_term" };
      return { keep: false, reason: "no_match" };
    },
  };
}

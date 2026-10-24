import type { PipelineConfig } from "@/lib/config";
import { companyFilterKeys, normalizeCompanyKey, resolveCompanyName, type CompanyMatchRow } from "@/lib/pipeline/company";

/** The push rule uses only resolved watch-list keys and the stored name_norm. */
export function buildWatchedCompanyKeys(watchedCompanies: readonly string[], pipeline: PipelineConfig): ReadonlySet<string> {
  return new Set(watchedCompanies.map((name) => resolveCompanyName(name, pipeline).nameNorm));
}

export function isCompanyWatched(row: { watched: boolean; nameNorm: string }, watchedKeys: ReadonlySet<string>): boolean {
  return row.watched || watchedKeys.has(row.nameNorm);
}

/** Both original and alias-resolved exclusion keys, as in the hard filter. */
export function buildBlacklistedCompanyKeys(excludedCompanies: readonly string[], pipeline: PipelineConfig): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const entry of excludedCompanies) for (const key of companyFilterKeys(entry, pipeline)) keys.add(key);
  return keys;
}

/** nameNorm can be stale; the hard filter checks the display name and persisted aliases, plus the DB flag. */
export function isCompanyExcluded(
  row: { blacklisted: boolean; name: string; nameNorm?: string | null; aliases: readonly string[] },
  blacklistedKeys: ReadonlySet<string>,
  legalSuffixes: readonly string[],
): boolean {
  return row.blacklisted || [row.name, ...row.aliases].some((name) => {
    const key = normalizeCompanyKey(name, legalSuffixes);
    return key !== "" && blacklistedKeys.has(key);
  });
}

/**
 * The watch-list entry that makes the push treat this company as watched (its resolved key is the stored `name_norm`): the
 * original spelling to pass to removeWatchedCompany, which removes an exact string ("Acme GmbH" for a row shown as "Acme").
 * Null when only the DB flag watches it, or nothing does.
 */
export function watchedEntryFor(row: Pick<CompanyMatchRow, "nameNorm">, watchedCompanies: readonly string[], pipeline: PipelineConfig): string | null {
  return watchedCompanies.find((entry) => resolveCompanyName(entry, pipeline).nameNorm === row.nameNorm) ?? null;
}

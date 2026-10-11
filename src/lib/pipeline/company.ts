import type { PipelineConfig } from "@/lib/config";

import { compileRules, matchesAny } from "./rules";

/**
 * Company-name key (ported from the legacy `normalizeCompanyKey`): accents folded, lower case,
 * punctuation removed, trailing legal forms (GmbH, AG, SE, Inc., "GmbH & Co. KG" ...) dropped, words
 * joined with hyphens. Parent / subsidiary / brand names are never merged heuristically: "Acme AI"
 * and "Acme" stay different; only the alias table of pipeline.yaml joins different spellings.
 */
export function normalizeCompanyKey(name: string, legalSuffixes: readonly string[]): string {
  const suffixes = new Set(legalSuffixes.map((s) => s.toLowerCase()));
  const words = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("en")
    .replace(/&/g, " and ")
    // "g.m.b.h." -> "gmbh": a dot after a single letter joins the letters
    .replace(/\b([a-z])\./g, "$1")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  let strippedSuffix = false;
  while (words.length > 1) {
    const last = words[words.length - 1] as string;
    if (suffixes.has(last)) {
      words.pop();
      strippedSuffix = true;
    } else if (last === "and" && strippedSuffix) {
      words.pop();
    } else {
      break;
    }
  }
  return words.join("-");
}

/** Alias spelling key -> canonical company display name, from `company.aliases`. */
function aliasIndex(config: PipelineConfig): Map<string, string> {
  const index = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(config.company.aliases)) {
    for (const alias of aliases) index.set(normalizeCompanyKey(alias, config.company.legal_suffixes), canonical);
  }
  return index;
}

const aliasCache = new WeakMap<PipelineConfig, Map<string, string>>();

export interface ResolvedCompanyName {
  /** Display name to store when the company does not exist yet. */
  name: string;
  /** `companies.name_norm`. */
  nameNorm: string;
  /** Other spellings to record on a newly created company. */
  aliases: string[];
}

/** The company a posting's company name stands for (aliases applied), before any database lookup. */
export function resolveCompanyName(rawName: string, config: PipelineConfig): ResolvedCompanyName {
  let index = aliasCache.get(config);
  if (!index) {
    index = aliasIndex(config);
    aliasCache.set(config, index);
  }
  const name = rawName.trim().replace(/\s+/g, " ");
  const ownKey = normalizeCompanyKey(name, config.company.legal_suffixes);
  const canonical = index.get(ownKey);
  if (canonical === undefined) return { name, nameNorm: ownKey, aliases: [] };
  return {
    name: canonical,
    nameNorm: normalizeCompanyKey(canonical, config.company.legal_suffixes),
    aliases: config.company.aliases[canonical] ?? [],
  };
}

/**
 * Whether the company is a known recruiter / staffing agency: its name starts with a name of the
 * table (legal forms ignored, so "Randstad Deutschland GmbH" matches "Randstad") or matches a name
 * pattern.
 */
export function isAgencyCompany(rawName: string, config: PipelineConfig): boolean {
  const key = normalizeCompanyKey(rawName, config.company.legal_suffixes);
  const known = config.company.agency_names.some((n) => {
    const agencyKey = normalizeCompanyKey(n, config.company.legal_suffixes);
    return key === agencyKey || key.startsWith(`${agencyKey}-`);
  });
  return known || matchesAny(compileRules(config).agencyCompanyName, rawName);
}

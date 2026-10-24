import type { PipelineConfig } from "@/lib/config";
import { MAX_FILTER_VALUE_CHARS } from "@/lib/jobs/constants";

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
 * The `name_norm` keys a company name written by the user (an exclusion of preferences.yaml, a company filter of /jobs) stands for:
 * its own key and the key of the company its alias resolves to under the current config. Both, because a stored company keeps the
 * key the config gave it when it was created: an alias added later must not lose the rows stored under the old spelling.
 */
export function companyFilterKeys(entry: string, config: PipelineConfig): Set<string> {
  const keys = new Set([normalizeCompanyKey(entry, config.company.legal_suffixes), resolveCompanyName(entry, config).nameNorm]);
  keys.delete("");
  return keys;
}

/** A stored company as the company filter compares it. */
export interface CompanyMatchRow {
  id: number;
  name: string;
  nameNorm: string;
  aliases: readonly string[];
}

/** The keys of a stored company: its `name_norm`, and its display name and stored aliases (raw spellings) normalized. */
export function storedCompanyKeys(row: Pick<CompanyMatchRow, "name" | "nameNorm" | "aliases">, legalSuffixes: readonly string[]): string[] {
  return [row.nameNorm, ...[row.name, ...row.aliases].map((name) => normalizeCompanyKey(name, legalSuffixes))].filter((key) => key !== "");
}

/** Stored company keys and display names indexed once for all company filters in a request. */
export interface CompanyMatchIndex {
  idsByKey: Map<string, number[]>;
  idsByDisplayName: Map<string, number[]>;
  rowsById: Map<number, CompanyMatchRow>;
  rowOrder: Map<number, number>;
  config: PipelineConfig;
}

export function buildCompanyMatchIndex(rows: readonly CompanyMatchRow[], config: PipelineConfig): CompanyMatchIndex {
  const index: CompanyMatchIndex = { idsByKey: new Map(), idsByDisplayName: new Map(), rowsById: new Map(), rowOrder: new Map(), config };
  const add = (map: Map<string, number[]>, key: string, id: number) => {
    const ids = map.get(key);
    if (ids) ids.push(id);
    else map.set(key, [id]);
  };
  for (const [order, row] of rows.entries()) {
    index.rowsById.set(row.id, row);
    index.rowOrder.set(row.id, order);
    add(index.idsByDisplayName, row.name.toLocaleLowerCase("en"), row.id);
    for (const key of new Set(storedCompanyKeys(row, config.company.legal_suffixes))) add(index.idsByKey, key, row.id);
  }
  return index;
}

/**
 * The ids of the stored companies that any of `names` picks: one of the company's keys (`storedCompanyKeys`) is among the name's
 * keys (`companyFilterKeys`), or its display name equals the name ignoring case (a name taken from a job row always finds that
 * row). Never a substring: "SAP" does not pick "SAP Fioneer".
 */
export function matchCompanyIds(rows: readonly CompanyMatchRow[], names: readonly string[], config: PipelineConfig): number[] {
  return matchCompanyIdsFromIndex(buildCompanyMatchIndex(rows, config), names);
}

/** `matchCompanyIds` with a reusable index; unique ids stay in stored row order, regardless of the names' order. */
export function matchCompanyIdsFromIndex(index: CompanyMatchIndex, names: readonly string[]): number[] {
  const matched = new Set<number>();
  for (const name of names) {
    for (const id of index.idsByDisplayName.get(name.trim().toLocaleLowerCase("en")) ?? []) matched.add(id);
    for (const key of companyFilterKeys(name, index.config)) for (const id of index.idsByKey.get(key) ?? []) matched.add(id);
  }
  return [...matched].sort((a, b) => index.rowOrder.get(a)! - index.rowOrder.get(b)!);
}

/**
 * `names` with each name that picks exactly one company written as that company's display name (`zalando` -> `Zalando`), so the
 * drop-down shows it ticked instead of as a value of its own; only when the display name picks that same company alone and a URL
 * can carry it. Other names
 * are kept as written; duplicates that result are dropped (first wins).
 */
export function canonicalCompanyNames(index: CompanyMatchIndex, names: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const [id, ...more] = matchCompanyIdsFromIndex(index, [name]);
    // a display name the URL could not carry (too long, blanks around it) is never written in
    const row = id !== undefined && more.length === 0 ? index.rowsById.get(id) : undefined;
    const sameAlone = row !== undefined && row.name === row.name.trim() && row.name.length > 0 && row.name.length <= MAX_FILTER_VALUE_CHARS && (() => {
      const back = matchCompanyIdsFromIndex(index, [row.name]);
      return back.length === 1 && back[0] === row.id;
    })();
    const canonical = row && sameAlone ? row.name : name;
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
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

/**
 * The spellings under which a company's name is looked for in a text: the name as stored, and the name without its legal
 * form ("Acme GmbH" and "Acme"), using the same legal-form list as the pipeline's company key (`legal_suffixes` of the
 * pipeline config and the market packs). Server only: the page gets the result with each name.
 */
import { ConfigError } from "@/lib/config";
import { loadPipeline, MarketUnresolvedError } from "@/lib/market";
import { normalizeCompanyKey } from "@/lib/pipeline/company";

/** The legal forms the pipeline strips from company names; empty when the pipeline config cannot be read (only the stored name is then looked for). */
export function legalSuffixes(): string[] {
  try {
    return [...loadPipeline().company.legal_suffixes];
  } catch (error) {
    if (error instanceof ConfigError || error instanceof MarketUnresolvedError) return [];
    throw error;
  }
}

/** The name as stored, then the same name without its legal form when that reads differently. */
export function companyMatchNames(company: string, suffixes: readonly string[]): string[] {
  const stored = company.trim().replace(/\s+/gu, " ");
  const names = [stored];
  const stripped = normalizeCompanyKey(stored, suffixes).replaceAll("-", " ");
  // the key of a name that has no letter or digit is the name itself; a key equal to the stored name adds nothing
  if (stripped !== "" && stripped.toLowerCase() !== stored.toLowerCase()) names.push(stripped);
  return names;
}

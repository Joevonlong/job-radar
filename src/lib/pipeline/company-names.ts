import type { CompaniesConfig, PipelineConfig } from "@/lib/config";
import type { Executor } from "@/lib/db/executor";
import { isTokenSpelling, listCompaniesByNameNorm, mergeCompanyInto, renameCompany } from "@/lib/db/repos/companies";

import { normalizeCompanyKey, resolveCompanyName } from "./company";

export interface CompanyNameSyncResult {
  /** Companies that got the display name of config/sources.yaml (ats_boards). */
  renamed: number;
  /** Companies that were the same company as another row (a token spelling and a proper one) and were folded into it. */
  merged: number;
}

/**
 * The ATS boards are listed in config/sources.yaml (ats_boards) with the company's display name. Companies the pipeline created
 * before a name was corrected (or from a posting that spelled the board token: "databricks") get that name now. A row
 * is only touched when its name is still the lower-case token spelling: a name that came from a posting or that the
 * user chose stays. When the corrected name is the key of another row, the two are one company and the token-named one
 * is folded into the other (flags of the token row are not lost: a watched or blacklisted one is left alone).
 */
export async function syncCompanyDisplayNames(db: Executor, input: { companies: CompaniesConfig["companies"]; pipeline: PipelineConfig }): Promise<CompanyNameSyncResult> {
  const result: CompanyNameSyncResult = { renamed: 0, merged: 0 };
  const { pipeline } = input;
  const suffixes = pipeline.company.legal_suffixes;

  for (const entry of input.companies) {
    const wanted = resolveCompanyName(entry.name, pipeline);
    const tokenKey = normalizeCompanyKey(entry.token, suffixes);
    const rows = await listCompaniesByNameNorm(db, [...new Set([wanted.nameNorm, tokenKey])]);
    const target = rows.find((row) => row.nameNorm === wanted.nameNorm) ?? null;
    const tokenRow = tokenKey === wanted.nameNorm ? null : (rows.find((row) => row.nameNorm === tokenKey && isTokenSpelling(row.name)) ?? null);

    if (target !== null && isTokenSpelling(target.name) && target.name !== wanted.name && target.name === wanted.name.toLowerCase()) {
      await renameCompany(db, target.id, { name: wanted.name, nameNorm: target.nameNorm, alias: target.name });
      result.renamed += 1;
    }
    if (tokenRow === null) continue;
    if (target === null) {
      await renameCompany(db, tokenRow.id, { name: wanted.name, nameNorm: wanted.nameNorm, alias: tokenRow.name });
      result.renamed += 1;
    } else if (!tokenRow.watched && !tokenRow.blacklisted) {
      await mergeCompanyInto(db, tokenRow.id, target.id);
      result.merged += 1;
    }
  }
  return result;
}

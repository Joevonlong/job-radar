import { asc } from "drizzle-orm";

import type { PipelineConfig } from "@/lib/config";
import { matchCompanyIds, type CompanyMatchRow } from "@/lib/pipeline/company";

import type { Executor } from "../executor";
import { companies } from "../schema";

/** Every stored company as the company filter compares it (the table is small: one row per employer). */
export async function listCompanyMatchRows(db: Executor): Promise<CompanyMatchRow[]> {
  return db.select({ id: companies.id, name: companies.name, nameNorm: companies.nameNorm, aliases: companies.aliases }).from(companies).orderBy(asc(companies.id));
}

/**
 * The ids of the companies the company filter `names` picks (`matchCompanyIds`: the same keys as the hard filter's company
 * exclusions, or the display name ignoring case). Empty `names` = no filter (null); names that pick no company = `[]` (an empty list).
 */
export async function resolveCompanyIds(db: Executor, names: readonly string[], pipeline: PipelineConfig): Promise<number[] | null> {
  if (names.length === 0) return null;
  return matchCompanyIds(await listCompanyMatchRows(db), names, pipeline);
}

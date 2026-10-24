import { asc } from "drizzle-orm";

import type { CompanyMatchRow } from "@/lib/pipeline/company";

import type { Executor } from "../executor";
import { companies } from "../schema";

/** Every stored company as the company filter compares it (the table is small: one row per employer). */
export async function listCompanyMatchRows(db: Executor): Promise<CompanyMatchRow[]> {
  return db.select({ id: companies.id, name: companies.name, nameNorm: companies.nameNorm, aliases: companies.aliases }).from(companies).orderBy(asc(companies.id));
}

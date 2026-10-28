import { and, asc, eq, ilike, inArray, sql } from "drizzle-orm";

import type { Executor } from "../executor";
import { companies, jobs } from "../schema";
import { moveSalaryLookups } from "./salary-lookups";

export type Company = typeof companies.$inferSelect;

export async function getCompanyByNameNorm(db: Executor, nameNorm: string): Promise<Company | null> {
  const [row] = await db.select().from(companies).where(eq(companies.nameNorm, nameNorm)).limit(1);
  return row ?? null;
}

/**
 * The company with this `name_norm`, created when missing (safe against a concurrent insert: the
 * unique key decides). An existing company keeps its name and flags; only a name that is the lower-case spelling of
 * a board token gets the capitalised spelling of the same name.
 */
export async function getOrCreateCompany(
  db: Executor,
  input: { name: string; nameNorm: string; aliases?: readonly string[] },
): Promise<Company> {
  await db
    .insert(companies)
    .values({ name: input.name, nameNorm: input.nameNorm, aliases: [...(input.aliases ?? [])] })
    .onConflictDoNothing({ target: companies.nameNorm });
  const row = await getCompanyByNameNorm(db, input.nameNorm);
  if (!row) throw new Error(`getOrCreateCompany: company "${input.nameNorm}" vanished after insert`);
  // a company first seen under a board token ("databricks") takes the proper spelling of a later posting ("Databricks")
  if (row.name !== input.name && isTokenSpelling(row.name) && !isTokenSpelling(input.name) && row.name === input.name.toLowerCase()) {
    await db.update(companies).set({ name: input.name }).where(eq(companies.id, row.id));
    return { ...row, name: input.name };
  }
  return row;
}

/** A name that is only lower case letters and digits: the spelling of a board token, not of a company ("databricks"). */
export const isTokenSpelling = (name: string): boolean => name === name.toLowerCase() && /^[a-z0-9]+$/.test(name);

/** The companies with these `name_norm` keys (keys without a company are absent). */
export async function listCompaniesByNameNorm(db: Executor, nameNorms: readonly string[]): Promise<Company[]> {
  if (nameNorms.length === 0) return [];
  return db.select().from(companies).where(inArray(companies.nameNorm, [...nameNorms]));
}

/** Give a company another display name (and the key that goes with it); the old name is kept as an alias. */
export async function renameCompany(db: Executor, id: number, input: { name: string; nameNorm: string; alias: string | null }): Promise<void> {
  await db
    .update(companies)
    .set({
      name: input.name,
      nameNorm: input.nameNorm,
      ...(input.alias ? { aliases: sql`case when ${input.alias}::text = any(${companies.aliases}) then ${companies.aliases} else array_append(${companies.aliases}, ${input.alias}::text) end` } : {}),
    })
    .where(eq(companies.id, id));
}

/**
 * Move every job and salary lookup of company `fromId` to `toId` and delete `fromId` (two rows that turned out to be one
 * company). `jobs` and `salary_lookups` are the only tables that reference a company; the lookups would otherwise go with
 * the deleted row (cascade).
 */
export async function mergeCompanyInto(db: Executor, fromId: number, toId: number): Promise<number> {
  const rows = await db.select({ id: companies.id, nameNorm: companies.nameNorm }).from(companies).where(inArray(companies.id, [fromId, toId]));
  const fromNorm = rows.find((row) => row.id === fromId)?.nameNorm;
  const toNorm = rows.find((row) => row.id === toId)?.nameNorm;
  if (fromNorm !== undefined && toNorm !== undefined) await moveSalaryLookups(db, { fromCompanyId: fromId, toCompanyId: toId, fromNorm, toNorm });
  const moved = await db.update(jobs).set({ companyId: toId }).where(eq(jobs.companyId, fromId)).returning({ id: jobs.id });
  await db.delete(companies).where(eq(companies.id, fromId));
  return moved.length;
}

/** Every company's id, display name, key, aliases and marks (for recomputing the keys when the key function changes). */
export async function listCompanyKeys(db: Executor): Promise<Array<Pick<Company, "id" | "name" | "nameNorm" | "aliases" | "watched" | "blacklisted">>> {
  return db
    .select({ id: companies.id, name: companies.name, nameNorm: companies.nameNorm, aliases: companies.aliases, watched: companies.watched, blacklisted: companies.blacklisted })
    .from(companies)
    .orderBy(asc(companies.id));
}

/**
 * Store another key for the company (its display name stays) when it still has key `from`; its salary lookups' cache keys
 * follow. Returns whether the row was changed. Run it in a transaction.
 */
export async function setCompanyNameNorm(db: Executor, id: number, from: string, nameNorm: string): Promise<boolean> {
  const changed = await db.update(companies).set({ nameNorm }).where(and(eq(companies.id, id), eq(companies.nameNorm, from))).returning({ id: companies.id });
  if (changed.length === 0) return false;
  await moveSalaryLookups(db, { fromCompanyId: id, toCompanyId: id, fromNorm: from, toNorm: nameNorm });
  return true;
}

/**
 * A company row for `nameNorm` with these marks, unless that key already has a row (which is left as it is). Returns the
 * id of the new row, or null.
 */
export async function insertCompanyIfAbsent(
  db: Executor,
  input: { name: string; nameNorm: string; aliases: readonly string[]; watched: boolean; blacklisted: boolean },
): Promise<number | null> {
  const [row] = await db
    .insert(companies)
    .values({ name: input.name, nameNorm: input.nameNorm, aliases: [...input.aliases], watched: input.watched, blacklisted: input.blacklisted })
    .onConflictDoNothing({ target: companies.nameNorm })
    .returning({ id: companies.id });
  return row?.id ?? null;
}

/** Add a spelling to the company's aliases (unless it is its name or already there). */
export async function addCompanyAlias(db: Executor, id: number, alias: string): Promise<void> {
  await db
    .update(companies)
    .set({ aliases: sql`case when ${alias}::text = any(${companies.aliases}) or ${alias}::text = ${companies.name} then ${companies.aliases} else array_append(${companies.aliases}, ${alias}::text) end` })
    .where(eq(companies.id, id));
}

/**
 * Fold company `fromId` into `toId` (two rows that one key now names): the target keeps its name and key, takes the other
 * row's name and aliases as aliases, its ATS board when it has none, and its watched / blacklisted marks; then the jobs move
 * and `fromId` is deleted (`mergeCompanyInto`). Run it in a transaction.
 */
export async function foldCompanyInto(db: Executor, fromId: number, toId: number): Promise<number> {
  const [from] = await db.select().from(companies).where(eq(companies.id, fromId)).limit(1);
  if (!from) return 0;
  const spellings = sql.join([from.name, ...from.aliases].map((spelling) => sql`${spelling}::text`), sql`, `);
  await db
    .update(companies)
    .set({
      aliases: sql`${companies.aliases} || array(select distinct t.x from unnest(array[${spellings}]) as t(x) where t.x <> all(${companies.aliases}) and t.x <> ${companies.name})`,
      atsKind: sql`coalesce(${companies.atsKind}, ${from.atsKind}::text)`,
      atsToken: sql`case when ${companies.atsKind} is null then ${from.atsToken}::text else ${companies.atsToken} end`,
      watched: sql`${companies.watched} or ${from.watched}`,
      blacklisted: sql`${companies.blacklisted} or ${from.blacklisted}`,
    })
    .where(eq(companies.id, toId));
  return mergeCompanyInto(db, fromId, toId);
}

export interface CompanySuggestion {
  name: string;
  /** Jobs of this company in the database. */
  jobCount: number;
}

/**
 * Jobs of the company row, as a correlated subquery. The outer column is written out with its table: drizzle leaves the table
 * off a column of a single-table select (`"id"`), which inside the subquery would bind to `jobs.id` and count the wrong rows.
 */
const jobCountOfCompany = sql<number>`(select count(*)::int from jobs where jobs.company_id = companies.id)`;

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Companies whose name contains `query` (case-insensitive), names that start with it first, then the ones with most jobs. For autocomplete. */
export async function suggestCompanies(db: Executor, query: string, limit: number): Promise<CompanySuggestion[]> {
  const text = query.trim().slice(0, 100);
  if (text === "") return [];
  const jobCount = jobCountOfCompany;
  return db
    .select({ name: companies.name, jobCount })
    .from(companies)
    .where(and(ilike(companies.name, `%${escapeLike(text)}%`), eq(companies.blacklisted, false)))
    .orderBy(sql`(${companies.name} ilike ${`${escapeLike(text)}%`}) desc`, sql`${jobCount} desc`, asc(companies.name))
    .limit(limit);
}

/** The companies with these `name_norm` keys and their job counts (keys without a company are absent). */
export async function listCompaniesWithJobCount(db: Executor, nameNorms: readonly string[]): Promise<Array<{ nameNorm: string; name: string; jobCount: number }>> {
  if (nameNorms.length === 0) return [];
  return db
    .select({ nameNorm: companies.nameNorm, name: companies.name, jobCount: jobCountOfCompany })
    .from(companies)
    .where(inArray(companies.nameNorm, [...nameNorms]));
}

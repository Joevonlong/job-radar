import { and, asc, desc, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { buildBlacklistedCompanyKeys, isCompanyExcluded, watchedEntriesFor } from "@/lib/companies/marks";
import type { PipelineConfig } from "@/lib/config";

import type { Executor } from "../executor";
import { companies, companyMerges, companyResearch, controlRequests, jobs, salaryLookups } from "../schema";
import { foldCompanyInto, getCompanyById, mergedWebsiteDomain, type Company } from "./companies";

/** The parts of the configuration that name companies; a merge does not change them, but it changes what they match. */
export interface CompanyMergeContext {
  pipeline: PipelineConfig;
  /** `interests.yaml: watched_companies`. */
  watchedCompanies: readonly string[];
  /** `preferences.yaml: exclude_companies`. */
  excludedCompanies: readonly string[];
  /** `ui.yaml: job_checks.ghost.trusted_companies` as `name_norm` keys. */
  trustedKeys: readonly string[];
}

export type CompanyMergeRefusal = "same_company" | "from_missing" | "into_missing" | "watched_and_blacklisted";

export type CompanyMergeNote =
  /** Two website domains: this one loses (it stays readable in the merge record). */
  | { kind: "website_domain_lost"; domain: string }
  /** An exclusion entry that names the removed row will exclude the whole kept company, through its new aliases. */
  | { kind: "excluded_entry_spreads" }
  /** A trusted-companies entry compares `name_norm` only: it stops matching. */
  | { kind: "trusted_entry_stops_matching" }
  /** Watch-list entries that name the removed row stop matching; the kept row gets the stored mark instead. */
  | { kind: "watch_entries_to_edit"; entries: string[] };

export interface CompanyMergePlan {
  from: Company;
  into: Company;
  /** Why this pair is not merged; null when it can be. */
  refusal: "watched_and_blacklisted" | null;
  jobs: number;
  openJobs: number;
  /** Of the jobs, those with an application or a favourite. */
  actedJobs: number;
  /** Jobs of the removed row whose title key the kept row also has: they stay separate jobs. */
  sameTitleJobs: number;
  salaryLookups: number;
  research: number;
  newAliases: string[];
  /** The kept row gets the stored watched mark, because a watch-list entry only matched the removed row. */
  setsWatched: boolean;
  notes: CompanyMergeNote[];
}

export type CompanyMergePlanResult = { refusal: Exclude<CompanyMergeRefusal, "watched_and_blacklisted"> } | CompanyMergePlan;

export class CompanyMergeRefused extends Error {
  constructor(readonly refusal: CompanyMergeRefusal | CompanyUndoRefusal) {
    super(`refused: ${refusal}`);
    this.name = "CompanyMergeRefused";
  }
}

/** The kept row's fields a merge can change, as `to_jsonb` writes them (timestamps at full precision). */
const companyFieldsSchema = z.object({
  aliases: z.array(z.string()),
  ats_kind: z.string().nullable(),
  ats_token: z.string().nullable(),
  watched: z.boolean(),
  blacklisted: z.boolean(),
  website_domain: z.string().nullable(),
  website_domain_source: z.string().nullable(),
  website_domain_confirmed_at: z.string().nullable(),
});
type CompanyFields = z.infer<typeof companyFieldsSchema>;

/** The removed row; columns added by later versions are kept as they are. */
const fromRowSchema = z.looseObject({ ...companyFieldsSchema.shape, id: z.number().int(), name: z.string(), name_norm: z.string() });

const movedSchema = z.object({
  jobIds: z.array(z.number().int()),
  salary: z.array(z.object({ id: z.number().int(), lookupKey: z.string() })),
  research: z.array(z.number().int()),
});

const mergeRecordSchema = z.object({ fromRow: fromRowSchema, intoBefore: companyFieldsSchema, intoAfter: companyFieldsSchema, moved: movedSchema });

async function companyJson(db: Executor, id: number): Promise<unknown> {
  const [row] = await db.execute<{ row: unknown }>(sql`select to_jsonb(c) as row from companies c where c.id = ${id}`);
  return row?.row ?? null;
}

const fieldsOf = (row: unknown): CompanyFields => {
  const { aliases, ats_kind, ats_token, watched, blacklisted, website_domain, website_domain_source, website_domain_confirmed_at } = companyFieldsSchema.parse(row);
  return { aliases, ats_kind, ats_token, watched, blacklisted, website_domain, website_domain_source, website_domain_confirmed_at };
};

/**
 * What merging `fromId` into `intoId` would do. Reads only. `--apply` runs the same function again under the row locks, so a dry
 * run and the merge report the same numbers as long as the data does not change between them.
 */
export async function planCompanyMerge(db: Executor, fromId: number, intoId: number, context: CompanyMergeContext): Promise<CompanyMergePlanResult> {
  if (fromId === intoId) return { refusal: "same_company" };
  const from = await getCompanyById(db, fromId);
  if (!from) return { refusal: "from_missing" };
  const into = await getCompanyById(db, intoId);
  if (!into) return { refusal: "into_missing" };

  const { pipeline } = context;
  const suffixes = pipeline.company.legal_suffixes;
  const fromEntries = watchedEntriesFor(from, context.watchedCompanies, pipeline);
  const intoEntries = watchedEntriesFor(into, context.watchedCompanies, pipeline);
  const fromWatched = from.watched || fromEntries.length > 0;
  const intoWatched = into.watched || intoEntries.length > 0;

  const [counts] = await db.execute<{ total: number; open: number; acted: number; same_title: number }>(sql`
    select
      count(*)::int as total,
      (count(*) filter (where j.status <> 'closed'))::int as open,
      (count(*) filter (where exists (select 1 from applications a where a.job_id = j.id) or exists (select 1 from job_favorites f where f.job_id = j.id)))::int as acted,
      (count(*) filter (where j.title_norm <> '' and exists (select 1 from jobs other where other.company_id = ${intoId} and other.title_norm = j.title_norm)))::int as same_title
    from jobs j where j.company_id = ${fromId}`);

  const notes: CompanyMergeNote[] = [];
  const domain = mergedWebsiteDomain(into, from);
  const lost = domain.websiteDomain === into.websiteDomain ? from.websiteDomain : into.websiteDomain;
  if (lost !== null && lost !== domain.websiteDomain) notes.push({ kind: "website_domain_lost", domain: lost });
  const excludedKeys = buildBlacklistedCompanyKeys(context.excludedCompanies, pipeline);
  const namedByExclusion = (row: Company): boolean => isCompanyExcluded({ blacklisted: false, name: row.name, aliases: row.aliases }, excludedKeys, suffixes);
  if (namedByExclusion(from) && !namedByExclusion(into)) notes.push({ kind: "excluded_entry_spreads" });
  if (context.trustedKeys.includes(from.nameNorm) && !context.trustedKeys.includes(into.nameNorm)) notes.push({ kind: "trusted_entry_stops_matching" });
  if (fromEntries.length > 0) notes.push({ kind: "watch_entries_to_edit", entries: fromEntries });

  const spellings = [...new Set([from.name, ...from.aliases])];
  return {
    from,
    into,
    refusal: (fromWatched && into.blacklisted) || (intoWatched && from.blacklisted) ? "watched_and_blacklisted" : null,
    jobs: counts?.total ?? 0,
    openJobs: counts?.open ?? 0,
    actedJobs: counts?.acted ?? 0,
    sameTitleJobs: counts?.same_title ?? 0,
    salaryLookups: await db.$count(salaryLookups, eq(salaryLookups.companyId, fromId)),
    research: await db.$count(companyResearch, eq(companyResearch.companyId, fromId)),
    newAliases: spellings.filter((spelling) => spelling !== into.name && !into.aliases.includes(spelling)),
    setsWatched: fromEntries.length > 0 && !into.watched,
    notes,
  };
}

export interface AppliedCompanyMerge {
  mergeId: number;
  plan: CompanyMergePlan;
}

/** The merge and its record, in the caller's transaction: both rows locked in id order, planned again, moved, recorded. */
export async function applyCompanyMerge(tx: Executor, fromId: number, intoId: number, context: CompanyMergeContext): Promise<AppliedCompanyMerge> {
  await tx.select({ id: companies.id }).from(companies).where(inArray(companies.id, [fromId, intoId])).orderBy(asc(companies.id)).for("update");
  const plan = await planCompanyMerge(tx, fromId, intoId, context);
  if (plan.refusal !== null) throw new CompanyMergeRefused(plan.refusal);

  const fromRow = fromRowSchema.parse(await companyJson(tx, fromId));
  const intoBefore = fieldsOf(await companyJson(tx, intoId));
  const jobRows = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.companyId, fromId)).orderBy(asc(jobs.id));
  const salaryRows = await tx.select({ id: salaryLookups.id, lookupKey: salaryLookups.lookupKey }).from(salaryLookups).where(eq(salaryLookups.companyId, fromId)).orderBy(asc(salaryLookups.id));
  const researchRows = await tx.select({ id: companyResearch.id }).from(companyResearch).where(eq(companyResearch.companyId, fromId)).orderBy(asc(companyResearch.id));
  const moved = movedSchema.parse({ jobIds: jobRows.map((row) => row.id), salary: salaryRows, research: researchRows.map((row) => row.id) });

  await foldCompanyInto(tx, fromId, intoId);
  if (plan.setsWatched) await tx.update(companies).set({ watched: true }).where(eq(companies.id, intoId));
  const intoAfter = fieldsOf(await companyJson(tx, intoId));

  const [record] = await tx.insert(companyMerges).values({ fromCompanyId: fromId, intoCompanyId: intoId, fromRow, intoBefore, intoAfter, moved }).returning({ id: companyMerges.id });
  if (!record) throw new Error("the merge record was not written");
  return { mergeId: record.id, plan };
}

/** The merge in force of `fromId` into `intoId` (not undone), or null: a plan run again reports such a pair as done. */
export async function findCompanyMerge(db: Executor, fromId: number, intoId: number): Promise<number | null> {
  const [row] = await db
    .select({ id: companyMerges.id })
    .from(companyMerges)
    .where(and(eq(companyMerges.fromCompanyId, fromId), eq(companyMerges.intoCompanyId, intoId), isNull(companyMerges.undoneAt)))
    .orderBy(desc(companyMerges.id))
    .limit(1);
  return row?.id ?? null;
}

/**
 * The AI requests a merge must not run under: `salary_lookup` writes with the company id it read before its AI call and would fail
 * on the removed row, losing a paid result. Pending ones are fine: the worker works out the company when it takes them.
 */
export async function listRunningCompanyAiRequests(db: Executor): Promise<number[]> {
  const rows = await db
    .select({ id: controlRequests.id })
    .from(controlRequests)
    .where(and(inArray(controlRequests.kind, ["salary_lookup", "company_research"]), eq(controlRequests.status, "running")))
    .orderBy(asc(controlRequests.id));
  return rows.map((row) => row.id);
}

export type CompanyUndoRefusal = "merge_missing" | "already_undone" | "from_key_taken" | "into_missing" | "later_merge";

export interface CompanyUndoPlan {
  mergeId: number;
  fromName: string;
  fromId: number;
  intoId: number;
  intoName: string | null;
  refusal: Exclude<CompanyUndoRefusal, "merge_missing"> | null;
  /** Recorded jobs, salary lookups and backgrounds that are still on the kept row. */
  jobs: number;
  salaryLookups: number;
  research: number;
  /** New since the merge and not undone by it: jobs on the kept row, and postings on those jobs or on the moved ones. */
  arrivedJobs: number;
  arrivedSources: number;
}

async function readMerge(db: Executor, mergeId: number) {
  const [row] = await db.select().from(companyMerges).where(eq(companyMerges.id, mergeId)).limit(1);
  return row ?? null;
}

/** What undoing the merge would do. Reads only. */
export async function planCompanyUndo(db: Executor, mergeId: number): Promise<CompanyUndoPlan | { refusal: "merge_missing" }> {
  const merge = await readMerge(db, mergeId);
  if (!merge) return { refusal: "merge_missing" };
  const { fromRow, moved } = mergeRecordSchema.parse(merge);
  const { fromCompanyId: fromId, intoCompanyId: intoId } = merge;

  const into = await getCompanyById(db, intoId);
  const [keyHolder] = await db.select({ id: companies.id }).from(companies).where(eq(companies.nameNorm, fromRow.name_norm)).limit(1);
  const ids = [fromId, intoId];
  const [later] = await db
    .select({ id: companyMerges.id })
    .from(companyMerges)
    .where(and(gt(companyMerges.id, mergeId), isNull(companyMerges.undoneAt), or(inArray(companyMerges.fromCompanyId, ids), inArray(companyMerges.intoCompanyId, ids))))
    .limit(1);
  const refusal: CompanyUndoPlan["refusal"] = merge.undoneAt !== null ? "already_undone" : later ? "later_merge" : !into ? "into_missing" : keyHolder ? "from_key_taken" : null;

  const movedJobs = sql.join([...moved.jobIds.map((id) => sql`${id}::bigint`), sql`null::bigint`], sql`, `);
  const [arrived] = await db.execute<{ jobs: number; sources: number }>(sql`
    select
      (select count(*)::int from jobs j where j.company_id = ${intoId} and j.first_seen_at >= m.merged_at) as jobs,
      (select count(*)::int from job_sources s join jobs j on j.id = s.job_id
        where (j.company_id = ${intoId} or j.id in (${movedJobs})) and s.first_seen_at >= m.merged_at) as sources
    from company_merges m where m.id = ${mergeId}`);

  return {
    mergeId,
    fromName: fromRow.name,
    fromId,
    intoId,
    intoName: into?.name ?? null,
    refusal,
    jobs: await db.$count(jobs, and(inArray(jobs.id, moved.jobIds), eq(jobs.companyId, intoId))),
    salaryLookups: await db.$count(salaryLookups, and(inArray(salaryLookups.id, moved.salary.map((row) => row.id)), eq(salaryLookups.companyId, intoId))),
    research: await db.$count(companyResearch, and(inArray(companyResearch.id, moved.research), eq(companyResearch.companyId, intoId))),
    arrivedJobs: arrived?.jobs ?? 0,
    arrivedSources: arrived?.sources ?? 0,
  };
}

export interface AppliedCompanyUndo {
  plan: CompanyUndoPlan;
  /** Fields of the kept row that changed after the merge, and so were left as they are. */
  keptFields: Array<"watched" | "blacklisted" | "ats" | "website_domain">;
}

type ScalarField = Exclude<keyof CompanyFields, "aliases">;
type CompanyUpdate = { [K in keyof typeof companies.$inferInsert]?: (typeof companies.$inferInsert)[K] | SQL };

/** Timestamps compare as moments: their text depends on the session's time zone. */
function sameField(key: ScalarField, a: string | boolean | null, b: string | boolean | null): boolean {
  return key === "website_domain_confirmed_at" && typeof a === "string" && typeof b === "string" ? Date.parse(a) === Date.parse(b) : a === b;
}

/**
 * Undo a merge in the caller's transaction: the removed row comes back under its own id, the recorded jobs, salary lookups (with
 * their old keys) and backgrounds that are still on the kept row move back, the kept row loses the aliases this merge added, and
 * its other fields go back only where they still have the value the merge left.
 */
export async function undoCompanyMerge(tx: Executor, mergeId: number): Promise<AppliedCompanyUndo> {
  const [locked] = await tx.select({ intoId: companyMerges.intoCompanyId }).from(companyMerges).where(eq(companyMerges.id, mergeId)).for("update");
  if (!locked) throw new CompanyMergeRefused("merge_missing");
  await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, locked.intoId)).for("update");
  const plan = await planCompanyUndo(tx, mergeId);
  if (plan.refusal !== null) throw new CompanyMergeRefused(plan.refusal);

  const merge = await readMerge(tx, mergeId);
  if (!merge) throw new CompanyMergeRefused("merge_missing");
  const record = mergeRecordSchema.parse(merge);
  const { fromId, intoId } = plan;
  const current = fieldsOf(await companyJson(tx, intoId));

  // the row as it was: every column, timestamps at full precision, its own id
  await tx.execute(sql`
    insert into companies (id, name, name_norm, aliases, ats_kind, ats_token, watched, blacklisted, website_domain, website_domain_source, website_domain_confirmed_at, created_at)
    overriding system value
    select r.id, r.name, r.name_norm, r.aliases, r.ats_kind, r.ats_token, r.watched, r.blacklisted, r.website_domain, r.website_domain_source, r.website_domain_confirmed_at, r.created_at
    from jsonb_populate_record(null::companies, ${JSON.stringify(merge.fromRow)}::jsonb) r`);

  if (record.moved.jobIds.length > 0) await tx.update(jobs).set({ companyId: fromId }).where(and(inArray(jobs.id, record.moved.jobIds), eq(jobs.companyId, intoId)));
  for (const lookup of record.moved.salary) {
    await tx.update(salaryLookups).set({ companyId: fromId, lookupKey: lookup.lookupKey }).where(and(eq(salaryLookups.id, lookup.id), eq(salaryLookups.companyId, intoId)));
  }
  if (record.moved.research.length > 0) await tx.update(companyResearch).set({ companyId: fromId }).where(and(inArray(companyResearch.id, record.moved.research), eq(companyResearch.companyId, intoId)));

  const { intoBefore: before, intoAfter: after } = record;
  const added = new Set(after.aliases.filter((alias) => !before.aliases.includes(alias)));
  const keptFields: AppliedCompanyUndo["keptFields"] = [];
  const restored: CompanyUpdate = { aliases: current.aliases.filter((alias) => !added.has(alias)) };
  /** Only what the merge changed goes back, and only while it still has the value the merge left. */
  const restoreField = (field: AppliedCompanyUndo["keptFields"][number], keys: ReadonlyArray<ScalarField>, values: CompanyUpdate): void => {
    if (keys.every((key) => sameField(key, before[key], after[key]))) return;
    if (keys.every((key) => sameField(key, current[key], after[key]))) Object.assign(restored, values);
    else keptFields.push(field);
  };
  restoreField("watched", ["watched"], { watched: before.watched });
  restoreField("blacklisted", ["blacklisted"], { blacklisted: before.blacklisted });
  restoreField("ats", ["ats_kind", "ats_token"], { atsKind: before.ats_kind, atsToken: before.ats_token });
  restoreField("website_domain", ["website_domain", "website_domain_source", "website_domain_confirmed_at"], {
    websiteDomain: before.website_domain,
    websiteDomainSource: before.website_domain_source,
    websiteDomainConfirmedAt: before.website_domain_confirmed_at === null ? null : sql`${before.website_domain_confirmed_at}::timestamptz`,
  });
  await tx.update(companies).set(restored).where(eq(companies.id, intoId));

  await tx.update(companyMerges).set({ undoneAt: sql`now()` }).where(eq(companyMerges.id, mergeId));
  return { plan, keptFields };
}

export interface CompanyMergeListing {
  id: number;
  mergedAt: Date;
  undoneAt: Date | null;
  fromId: number;
  fromName: string;
  intoId: number;
  intoName: string | null;
  jobs: number;
}

/** The merge records, newest first. */
export async function listCompanyMerges(db: Executor): Promise<CompanyMergeListing[]> {
  const rows = await db
    .select({ merge: companyMerges, intoName: companies.name })
    .from(companyMerges)
    .leftJoin(companies, eq(companies.id, companyMerges.intoCompanyId))
    .orderBy(desc(companyMerges.id));
  return rows.map(({ merge, intoName }) => {
    const record = mergeRecordSchema.parse(merge);
    return { id: merge.id, mergedAt: merge.mergedAt, undoneAt: merge.undoneAt, fromId: merge.fromCompanyId, fromName: record.fromRow.name, intoId: merge.intoCompanyId, intoName, jobs: record.moved.jobIds.length };
  });
}

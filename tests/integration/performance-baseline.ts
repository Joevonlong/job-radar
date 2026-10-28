/** Frozen query baselines from main 914dc3e. Keep the old SQL when optimizing the runtime queries. */
import { and, asc, desc, eq, gt, inArray, lte, ne, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import type { Executor } from "@/lib/db/executor";
import { aiUsage, companies, jobs, runs, rawPostings } from "@/lib/db/schema";
import { notDormantSql } from "@/lib/db/queries/job-status";
import { dormancyReady } from "@/lib/db/repos/dormancy";
import { checkTableReady } from "@/lib/db/repos/job-checks";
import type { GhostCheckListOptions, GhostCheckCandidate } from "@/lib/db/repos/ghost";
import type { VisaScanListOptions, VisaScanCandidate } from "@/lib/db/repos/visa";
import type { ScanCandidate } from "@/lib/db/repos/signals";
import type { TrapScanCandidate } from "@/lib/db/repos/traps";
import type { FilterCandidate } from "@/lib/db/repos/filter-results";
import type { RecentRun, MonthRunTotals, AiUsageRow } from "@/lib/db/queries/sources";
import type { RawUpsertItem, RawUpsertResult } from "@/lib/db/repos/raw-postings";
import { hashPayload } from "@/lib/db/repos/raw-postings";
const CHUNK=500;
function chunks<T>(items: readonly T[], size: number): T[][] {
 const out:T[][]=[]; for(let i=0;i<items.length;i+=size)out.push(items.slice(i,i+size));return out;
}


const textArray = (values: readonly string[]): SQL => (values.length === 0 ? sql`array[]::text[]` : sql`array[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]`);

function ghostInputHashSql(options: GhostCheckListOptions): SQL {
  const spans = options.withTrapSpans ? sql`coalesce(ts.spans_hash, '')` : sql`''`;
  const payloadChannels = textArray(options.payloadChannels);
  const sources = sql`coalesce((
    select string_agg(concat_ws('|', s.channel_id, r.external_id,
      case when s.channel_id = any(${payloadChannels}) then coalesce(r.payload_hash, md5(r.payload_json::text)) else '' end,
      extract(epoch from s.first_seen_at)::text, coalesce(s.location_label, ''), s.priority::text), ',' order by s.id)
    from job_sources s join raw_postings r on r.id = s.raw_posting_id
    where s.job_id = j.id), '')`;
  const breakdown = sql`coalesce((select concat_ws('|', b.source_hash, b.prompt_version, md5(b.content::text)) from job_breakdowns b where b.job_id = j.id), '')`;
  const trusted = sql`(coalesce(c.name_norm, '') = any(${textArray(options.trustedKeys)}))::text`;
  return sql`md5(concat_ws(':', md5(coalesce(j.description, '')), j.status::text, extract(epoch from j.first_seen_at)::text, ${options.rulesHash}::text, ${trusted}, ${sources}, ${breakdown}, ${spans}))`;
}

export async function oldListJobsToGhostCheck(db: Executor, options: GhostCheckListOptions): Promise<GhostCheckCandidate[]> {
  if (!(await checkTableReady(db, "job_ghost"))) return [];
  const ids = options.jobIds ?? null;
  if (ids !== null && ids.length === 0) return [];
  const hash = ghostInputHashSql(options);
  const only = ids === null ? sql`j.status <> 'closed' and ${notDormantSql(await dormancyReady(db), 'j')}` : sql`j.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`;
  const outdated = options.force ? sql`true` : sql`(g.job_id is null or g.input_hash <> ${hash} or (g.recheck_at is not null and g.recheck_at <= ${options.now.toISOString()}::timestamptz))`;
  const trapJoin = options.withTrapSpans ? sql`left join trap_scans ts on ts.job_id = j.id` : sql``;
  const rows = await db.execute<{ id: string | number; input_hash: string; fresh: boolean }>(sql`
    select j.id, ${hash} as input_hash, (g.job_id is null) as fresh
    from jobs j
    left join companies c on c.id = j.company_id
    ${trapJoin}
    left join job_ghost g on g.job_id = j.id
    where ${only} and ${outdated}
    order by (g.job_id is null) desc, j.first_seen_at desc, j.id desc
    limit ${options.limit}
  `);
  return Array.from(rows, (r) => ({ jobId: Number(r.id), inputHash: r.input_hash, fresh: r.fresh }));
}

function visaInputHashSql(rulesHash: string, withTrapSpans: boolean): SQL {
  const spans = withTrapSpans ? sql`coalesce(ts.spans_hash, '')` : sql`''`;
  return sql`md5(concat_ws(':', md5(coalesce(j.description, '')), ${rulesHash}::text, coalesce(c.name_norm, ''), ${spans}))`;
}

export async function oldListJobsToVisaScan(db: Executor, options: VisaScanListOptions): Promise<VisaScanCandidate[]> {
  if (!(await checkTableReady(db, "job_visa"))) return [];
  const ids = options.jobIds ?? null;
  if (ids !== null && ids.length === 0) return [];
  const hash = visaInputHashSql(options.rulesHash, options.withTrapSpans);
  const only = ids === null ? sql`j.status <> 'closed' and ${notDormantSql(await dormancyReady(db), 'j')}` : sql`j.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`;
  const outdated = options.force ? sql`true` : sql`(v.job_id is null or v.input_hash <> ${hash})`;
  const trapJoin = options.withTrapSpans ? sql`left join trap_scans ts on ts.job_id = j.id` : sql``;
  const rows = await db.execute<{ id: string | number; input_hash: string; fresh: boolean }>(sql`
    select j.id, ${hash} as input_hash, (v.job_id is null) as fresh
    from jobs j
    left join companies c on c.id = j.company_id
    ${trapJoin}
    left join job_visa v on v.job_id = j.id
    where ${only} and ${outdated}
    order by (v.job_id is null) desc, j.first_seen_at desc, j.id desc
    limit ${options.limit}
  `);
  return Array.from(rows, (r) => ({ jobId: Number(r.id), inputHash: r.input_hash, fresh: r.fresh }));
}

export async function oldListJobsToScan(db: Executor, options: { rulesHash: string; afterId: number; limit: number }): Promise<ScanCandidate[]> {
  const rows = await db.execute<{ id: string; title: string; description: string; salary_json: unknown; salary_hash: string }>(sql`
    select j.id, j.title, j.description, j.salary_json, md5(coalesce(j.salary_json::text, '')) as salary_hash
    from jobs j
    left join signal_scans s on s.job_id = j.id
    where j.id > ${options.afterId}
      and ${notDormantSql(await dormancyReady(db), 'j')}
      and j.description is not null and btrim(j.description) <> ''
      and (s.job_id is null or s.description_hash <> md5(j.description) or s.rules_hash <> ${options.rulesHash})
    order by j.id
    limit ${options.limit}
  `);
  return Array.from(rows, (r) => ({ id: Number(r.id), title: r.title, description: r.description, salaryJson: r.salary_json, salaryHash: r.salary_hash }));
}

export async function oldListJobsToSyncSalary(db: Executor, options: { afterId: number; limit: number }): Promise<ScanCandidate[]> {
  const rows = await db.execute<{ id: string; title: string; description: string; salary_json: unknown; salary_hash: string }>(sql`
    select j.id, j.title, j.description, j.salary_json, md5(coalesce(j.salary_json::text, '')) as salary_hash
    from jobs j
    join signal_scans s on s.job_id = j.id
    where j.id > ${options.afterId}
      and ${notDormantSql(await dormancyReady(db), 'j')}
      and j.description is not null and btrim(j.description) <> ''
      and s.description_hash = md5(j.description)
      and s.salary_hash is distinct from md5(coalesce(j.salary_json::text, ''))
    order by j.id
    limit ${options.limit}
  `);
  return Array.from(rows, (r) => ({ id: Number(r.id), title: r.title, description: r.description, salaryJson: r.salary_json, salaryHash: r.salary_hash }));
}

const SOURCES_CTE = sql`src as (
    select js.job_id,
      md5(coalesce(string_agg(js.raw_posting_id::text || ':' || coalesce(rp.payload_hash, md5(rp.payload_json::text)), ',' order by js.raw_posting_id), '')) as sources_hash
    from job_sources js
    join raw_postings rp on rp.id = js.raw_posting_id
    group by js.job_id
  )`;

export async function oldListJobsToTrapScan(db: Executor, options: { rulesHash: string; limit: number; jobIds?: readonly number[] | null; force?: boolean }): Promise<TrapScanCandidate[]> {
  const ids = options.jobIds ?? null;
  if (ids !== null && ids.length === 0) return [];
  const only = ids === null ? notDormantSql(await dormancyReady(db), 'j') : sql`j.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`;
  const outdated = options.force
    ? sql`true`
    : sql`(ts.job_id is null or ts.description_hash <> md5(coalesce(j.description, '')) or ts.sources_hash <> coalesce(src.sources_hash, md5('')) or ts.rules_hash <> ${options.rulesHash})`;
  const rows = await db.execute<{ id: string | number; description_hash: string; sources_hash: string; fresh: boolean }>(sql`
    with ${SOURCES_CTE}
    select j.id, md5(coalesce(j.description, '')) as description_hash, coalesce(src.sources_hash, md5('')) as sources_hash, (ts.job_id is null) as fresh
    from jobs j
    left join src on src.job_id = j.id
    left join trap_scans ts on ts.job_id = j.id
    where ${only} and ${outdated}
    order by (ts.job_id is null) desc, j.first_seen_at desc, j.id desc
    limit ${options.limit}
  `);
  return Array.from(rows, (r) => ({ jobId: Number(r.id), descriptionHash: r.description_hash, sourcesHash: r.sources_hash, fresh: r.fresh }));
}

export async function oldListFilterCandidates(db: Executor, input: { afterId: number; limit: number; jobIds?: readonly number[] }): Promise<FilterCandidate[]> {
  return db
    .select({
      id: jobs.id,
      title: jobs.title,
      description: jobs.description,
      workplace: jobs.workplace,
      seniority: jobs.seniority,
      contract: jobs.contract,
      locationsJson: jobs.locationsJson,
      salaryJson: jobs.salaryJson,
      companyName: companies.name,
      companyNameNorm: companies.nameNorm,
      companyAliases: companies.aliases,
      companyBlacklisted: companies.blacklisted,
      companyWatched: companies.watched,
      germanLevel: jobs.germanLevelRequired,
    })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(and(gt(jobs.id, input.afterId), ne(jobs.status, "closed"), input.jobIds ? inArray(jobs.id, [...input.jobIds]) : notDormantSql(await dormancyReady(db))))
    .orderBy(asc(jobs.id))
    .limit(input.limit);
}

export async function oldListRecentRunsByChannel(db: Db, perChannel: number): Promise<Map<string, RecentRun[]>> {
  const ranked = db
    .select({
      id: runs.id,
      channelId: runs.channelId,
      cycleId: runs.cycleId,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      status: runs.status,
      fetched: runs.fetched,
      newCount: runs.newCount,
      cost: runs.cost,
      errorCode: runs.errorCode,
      error: runs.error,
      interrupted: runs.interrupted,
      rank: sql<number>`row_number() over (partition by ${runs.channelId} order by ${runs.startedAt} desc, ${runs.id} desc)`.as("rank"),
    })
    .from(runs)
    .as("ranked");
  const rows = await db
    .select()
    .from(ranked)
    .where(lte(ranked.rank, perChannel))
    .orderBy(asc(ranked.channelId), desc(ranked.startedAt), desc(ranked.id));
  const byChannel = new Map<string, RecentRun[]>();
  for (const { rank: _rank, channelId, ...run } of rows) {
    void _rank;
    const list = byChannel.get(channelId) ?? [];
    list.push(run);
    byChannel.set(channelId, list);
  }
  return byChannel;
}

export async function oldGetMonthRunTotals(db: Db, args: { month: string; timeZone: string }): Promise<Map<string, MonthRunTotals>> {
  const rows = await db
    .select({
      channelId: runs.channelId,
      runs: sql<number>`count(*)::int`,
      fetched: sql<number>`coalesce(sum(${runs.fetched}), 0)::int`,
      newCount: sql<number>`coalesce(sum(${runs.newCount}), 0)::int`,
    })
    .from(runs)
    // a skipped run counts when it stored postings (a query that stopped at its budget after some of its requests)
    .where(and(sql`to_char(${runs.startedAt} at time zone ${args.timeZone}, 'YYYY-MM') = ${args.month}`, or(ne(runs.status, "skipped"), gt(runs.fetched, 0))))
    .groupBy(runs.channelId);
  return new Map(rows.map(({ channelId, ...totals }) => [channelId, totals]));
}

export async function oldGetAiUsageForMonth(db: Db, args: { month: string; timeZone: string }): Promise<AiUsageRow[]> {
  const rows = await db
    .select({
      provider: aiUsage.provider,
      task: aiUsage.task,
      calls: sql<number>`count(*)::int`,
      tokensIn: sql<number>`coalesce(sum(${aiUsage.tokensIn}), 0)::bigint`,
      tokensOut: sql<number>`coalesce(sum(${aiUsage.tokensOut}), 0)::bigint`,
      costUsd: sql<string>`coalesce(sum(${aiUsage.costEstimate}), 0)`,
    })
    .from(aiUsage)
    .where(sql`to_char(${aiUsage.at} at time zone ${args.timeZone}, 'YYYY-MM') = ${args.month}`)
    .groupBy(aiUsage.provider, aiUsage.task)
    .orderBy(asc(aiUsage.provider), asc(aiUsage.task));
  return rows.map((row) => ({ ...row, tokensIn: Number(row.tokensIn), tokensOut: Number(row.tokensOut), costUsd: Number(row.costUsd) }));
}

export async function oldSumAiCostForMonth(db: Db, args: { month: string; timeZone: string; providers: readonly string[] }): Promise<number> {
  if (args.providers.length === 0) return 0;
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${aiUsage.costEstimate}), 0)` })
    .from(aiUsage)
    .where(
      and(
        inArray(aiUsage.provider, [...args.providers]),
        sql`to_char(${aiUsage.at} at time zone ${args.timeZone}, 'YYYY-MM') = ${args.month}`,
      ),
    );
  return Number(row?.total ?? 0);
}

export async function oldUpsertRawPostings(
  db: Db,
  input: { channelId: string; runId: number | null; items: readonly RawUpsertItem[]; fetchedAt?: Date },
): Promise<RawUpsertResult> {
  const byId = new Map<string, RawUpsertItem & { hash: string }>();
  for (const item of input.items) {
    byId.set(item.externalId, { ...item, payload: JSON.parse(JSON.stringify(item.payload)), hash: hashPayload(item.payload) });
  }
  const items = [...byId.values()];
  const result: RawUpsertResult = { inserted: 0, changed: 0, unchanged: 0 };
  if (items.length === 0) return result;
  const fetchedAt = input.fetchedAt ?? sql`now()`; // database clock, like the other defaults

  await db.transaction(async (tx) => {
    const existing = new Map<string, string | null>();
    for (const part of chunks(items, 1000)) {
      const rows = await tx
        .select({ externalId: rawPostings.externalId, hash: rawPostings.payloadHash })
        .from(rawPostings)
        .where(
          and(
            eq(rawPostings.channelId, input.channelId),
            inArray(
              rawPostings.externalId,
              part.map((i) => i.externalId),
            ),
          ),
        );
      for (const row of rows) existing.set(row.externalId, row.hash);
    }
    for (const item of items) {
      if (!existing.has(item.externalId)) result.inserted += 1;
      else if (existing.get(item.externalId) === item.hash) result.unchanged += 1;
      else result.changed += 1;
    }

    for (const part of chunks(items, CHUNK)) {
      await tx
        .insert(rawPostings)
        .values(
          part.map((i) => ({
            channelId: input.channelId,
            externalId: i.externalId,
            url: i.url,
            payloadJson: i.payload,
            payloadHash: i.hash,
            fetchedAt,
            runId: input.runId,
          })),
        )
        .onConflictDoUpdate({
          target: [rawPostings.channelId, rawPostings.externalId],
          set: {
            payloadJson: sql`excluded.payload_json`,
            url: sql`coalesce(excluded.url, ${rawPostings.url})`,
            fetchedAt: sql`excluded.fetched_at`,
            runId: sql`excluded.run_id`,
            parseStatus: sql`case when ${rawPostings.payloadHash} is distinct from excluded.payload_hash then 'pending'::parse_status else ${rawPostings.parseStatus} end`,
            parseError: sql`case when ${rawPostings.payloadHash} is distinct from excluded.payload_hash then null else ${rawPostings.parseError} end`,
            payloadHash: sql`excluded.payload_hash`,
          },
        });
    }
  });
  return result;
}

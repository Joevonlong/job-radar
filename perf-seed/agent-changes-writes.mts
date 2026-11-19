import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import postgres, { type Sql } from "postgres";
import { z } from "zod";

import { checkedDatabase, checkedUrl, moduleAt, outputArgs } from "./common.mts";
import type { FixturePosting } from "../src/lib/channels/fixture";
import type { CompanyMergeContext } from "../src/lib/db/repos/company-merges";
import type { NewFilterResult } from "../src/lib/db/repos/filter-results";
import type { SeenResult } from "../src/lib/db/repos/jobs";
import type { SalaryBenchmarkInput } from "../src/lib/db/repos/salary-benchmarks";

const MODES = ["off", "on"] as const;
const METRICS = ["ms", "wal_bytes", "change_rows"] as const;
const TRIGGER_ROW = 1;
const TRIGGER_EVENTS = { insert: 4, delete: 8, update: 16 };
const SEPARATE_INSERT_DELETE = new Set(["applications", "job_traps", "scores"]);
const SCORE_JOBS = 10_000;
const COLLECTION_POSTINGS = 500;
const COLLECTION_HEARTBEATS = 5_000;
const HEARTBEAT_JOBS = 10_000;
const EXTRA_MERGE_JOBS_PER_COMPANY = 500;
const TRAP_BATCH = 500;
const TIME_LIMIT_PCT = 10;
const WAL_LIMIT_PCT = 20;

type Mode = (typeof MODES)[number];
type Metrics = Record<(typeof METRICS)[number], number>;
type Sample = Metrics & { details: Record<string, number> };
type Trial = Metrics & { phases: Record<string, Sample> };
type Phase = { name: string; work: () => Promise<Sample["details"]> };
type Connection = ReturnType<typeof import("../src/lib/db/client").createConnection>;
type Prepare = (connection: Connection) => Promise<Phase[]>;

async function loadProduct(root: string) {
  const client = await import(moduleAt(root, "src/lib/db/client.ts")) as typeof import("../src/lib/db/client");
  const sync = await import(moduleAt(root, "src/lib/db/sync-sources.ts")) as typeof import("../src/lib/db/sync-sources");
  const scores = await import(moduleAt(root, "src/lib/db/repos/scores.ts")) as typeof import("../src/lib/db/repos/scores");
  const currentScores = await import(moduleAt(root, "src/lib/db/repos/current-scores.ts")) as typeof import("../src/lib/db/repos/current-scores");
  const filter = await import(moduleAt(root, "src/lib/db/repos/filter-results.ts")) as typeof import("../src/lib/db/repos/filter-results");
  const raw = await import(moduleAt(root, "src/lib/db/repos/raw-postings.ts")) as typeof import("../src/lib/db/repos/raw-postings");
  const jobs = await import(moduleAt(root, "src/lib/db/repos/jobs.ts")) as typeof import("../src/lib/db/repos/jobs");
  const pipeline = await import(moduleAt(root, "src/lib/pipeline/index.ts")) as typeof import("../src/lib/pipeline/index");
  const registry = await import(moduleAt(root, "src/lib/channels/registry.ts")) as typeof import("../src/lib/channels/registry");
  const fixture = await import(moduleAt(root, "src/lib/channels/fixture/index.ts")) as typeof import("../src/lib/channels/fixture");
  const { createLogger } = await import(moduleAt(root, "src/lib/channels/logger.ts")) as typeof import("../src/lib/channels/logger");
  const merges = await import(moduleAt(root, "src/lib/db/repos/company-merges.ts")) as typeof import("../src/lib/db/repos/company-merges");
  const lookup = await import(moduleAt(root, "src/lib/salary/lookup-key.ts")) as typeof import("../src/lib/salary/lookup-key");
  const trapRepo = await import(moduleAt(root, "src/lib/db/repos/traps.ts")) as typeof import("../src/lib/db/repos/traps");
  const traps = await import(moduleAt(root, "src/lib/traps/step.ts")) as typeof import("../src/lib/traps/step");
  const salaryRepo = await import(moduleAt(root, "src/lib/db/repos/salary-benchmarks.ts")) as typeof import("../src/lib/db/repos/salary-benchmarks");
  const salary = await import(moduleAt(root, "src/lib/salary/benchmark.ts")) as typeof import("../src/lib/salary/benchmark");
  const families = await import(moduleAt(root, "src/lib/salary/families.ts")) as typeof import("../src/lib/salary/families");
  const { loadConfig } = await import(moduleAt(root, "src/lib/config/load.ts")) as typeof import("../src/lib/config/load");
  const { buildEffectivePipeline, resolveMarket } = await import(moduleAt(root, "src/lib/market/index.ts")) as typeof import("../src/lib/market");
  const pipelineConfig = buildEffectivePipeline(loadConfig("pipeline"), resolveMarket({ pack: "de" }));
  const sightings = { relistMinGapDays: pipeline.REPLAY_RELIST.minGapDays };
  const logger = createLogger({ minLevel: "error" });
  return { client, sync, scores, currentScores, filter, raw, jobs, pipeline, registry, fixture, merges, lookup, trapRepo, traps, salaryRepo, salary, families, loadConfig, pipelineConfig, sightings, logger };
}

type Product = Awaited<ReturnType<typeof loadProduct>>;

/** The catalog may combine INSERT and DELETE in one trigger. */
function expectedTriggers(sources: Product["sync"]["SYNC_SOURCES"]) {
  const expected = new Map<string, number>();
  for (const { table, operations } of sources) {
    for (const operation of operations) {
      const event = operation === "update" || SEPARATE_INSERT_DELETE.has(table) ? operation : "presence";
      const key = `${table}.agent_change_${event}`;
      expected.set(key, (expected.get(key) ?? (table === "scores" ? 0 : TRIGGER_ROW)) | TRIGGER_EVENTS[operation]);
    }
  }
  return expected;
}

/** PostgreSQL still captures transition rows for disabled triggers. Off trials drop those triggers from the copy. */
async function readAgentTriggers(sql: Sql, sources: Product["sync"]["SYNC_SOURCES"]) {
  const expected = expectedTriggers(sources);
  const triggers = await sql<{ schema: string; function_name: string; key: string; type: number; enabled: string; turn_off: string }[]>`
    select n.nspname as schema, p.proname as function_name, c.relname || '.' || t.tgname as key,
      t.tgtype::int as type, t.tgenabled::text as enabled,
      case when t.tgoldtable is not null or t.tgnewtable is not null
        then format('drop trigger %I on %I.%I', t.tgname, n.nspname, c.relname)
        else format('alter table %I.%I disable trigger %I', n.nspname, c.relname, t.tgname)
      end as turn_off
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal
      and (starts_with(t.tgname::text, 'agent_change_') or starts_with(p.proname::text, 'agent_changes_'))
    order by n.nspname, c.relname, t.tgname`;
  if (triggers.length !== expected.size) throw new Error(`Expected ${expected.size} agent-change triggers, found ${triggers.length}. Check the template migrations.`);
  for (const trigger of triggers) {
    if (trigger.schema !== "public" || !trigger.function_name.startsWith("agent_changes_") || trigger.enabled !== "O" ||
        expected.get(trigger.key) !== trigger.type) {
      throw new Error(`Unexpected agent-change trigger ${trigger.schema}.${trigger.key}`);
    }
    expected.delete(trigger.key);
  }
  return triggers;
}

async function measure(sql: Sql, work: Phase["work"]): Promise<Sample> {
  const [before] = await sql<{ n: number }[]>`select count(*)::int as n from public.agent_changes`;
  await sql.unsafe("checkpoint");
  const [{ lsn }] = await sql<{ lsn: string }[]>`select pg_current_wal_lsn()::text as lsn`;
  const started = performance.now();
  const details = await work();
  const ms = performance.now() - started;
  const [{ bytes }] = await sql<{ bytes: string }[]>`select pg_wal_lsn_diff(pg_current_wal_lsn(), ${lsn}::pg_lsn)::bigint as bytes`;
  const [after] = await sql<{ n: number }[]>`select count(*)::int as n from public.agent_changes`;
  return { ms, wal_bytes: Number(bytes), change_rows: after.n - before.n, details };
}

async function prepareRescore({ db, sql }: Connection, product: Product): Promise<Phase[]> {
  const [{ id: snapshot }] = await sql<{ id: number }[]>`
    insert into profile_snapshots (kind, hash, content_yaml) values ('preferences', 'agent-changes-write-fixture', 'fixture')
    returning id::int as id`;
  await sql`
    with selected as (
      select distinct on (job_id) id from scores where score is not null
      order by job_id, created_at desc, id desc limit ${SCORE_JOBS}
    )
    update scores s set stale = selected.id is null
    from scores scored left join selected on selected.id = scored.id
    where s.id = scored.id and s.score is not null and s.stale is distinct from (selected.id is null)`;
  await product.currentScores.rebuildCurrentScores(db, { batchJobs: SCORE_JOBS });
  const jobs = await sql<{ id: number }[]>`select id::int as id from jobs where status <> 'closed' and dormant_at is null order by id`;
  if (jobs.length === 0) throw new Error("The template has no jobs for the filter write");
  const rows: NewFilterResult[] = jobs.map(({ id }) => ({ jobId: id, filterResult: "passed", filterReasons: [] }));
  return [
    { name: "ten_thousand", work: async () => {
      const scores = await product.currentScores.scoreTransaction(db, (tx) => product.scores.markScoresStaleExcept(tx, snapshot));
      if (scores !== SCORE_JOBS) throw new Error(`Expected to mark ${SCORE_JOBS} scores stale, wrote ${scores}`);
      return { scores_written: scores };
    } },
    { name: "filter", work: async () => {
      const scores = await product.currentScores.scoreTransaction(db, async (tx) => {
        let written = 0;
        for (let offset = 0; offset < rows.length; offset += SCORE_JOBS) {
          written += await product.filter.insertFilterResults(tx, snapshot, rows.slice(offset, offset + SCORE_JOBS));
        }
        return written;
      });
      if (scores !== rows.length) throw new Error(`Expected ${rows.length} fresh filter results, wrote ${scores}`);
      return { scores_written: scores };
    } },
  ];
}

async function stageHeartbeat({ db, sql }: Connection, product: Product, count: number, exclude: number[] = []) {
  await product.jobs.touchJobsSeen(db, product.sightings);
  const selected = await sql`
    with selected as (
      select j.id, j.last_seen_at, j.last_listed_at, s.raw_posting_id from jobs j
      join lateral (select raw_posting_id from job_sources where job_id = j.id order by raw_posting_id limit 1) s on true
      where j.id <> all(${sql.array(exclude, 20)}::bigint[])
      order by (j.status = 'active') desc, j.id limit ${count}
    ), active as (
      update jobs j set status = 'active', dormant_at = null from selected s
      where j.id = s.id and (j.status <> 'active' or j.dormant_at is not null)
    )
    update raw_postings r set fetched_at = greatest(s.last_seen_at, s.last_listed_at) + interval '1 second'
    from selected s where r.id = s.raw_posting_id`;
  if (selected.count !== count) throw new Error(`Expected ${count} seeded heartbeat sources, found ${selected.count}`);
}

function seenDetails(result: SeenResult, expected: number) {
  if (result.seen !== expected || result.reopened !== 0 || result.relisted !== 0) {
    throw new Error(`Expected ${expected} sightings without reopen or relist, got ${JSON.stringify(result)}`);
  }
  return { jobs_seen: result.seen };
}

async function prepareHeartbeat(connection: Connection, product: Product): Promise<Phase[]> {
  await stageHeartbeat(connection, product, HEARTBEAT_JOBS);
  return [{ name: "heartbeat", work: async () => seenDetails(await product.jobs.touchJobsSeen(connection.db, product.sightings), HEARTBEAT_JOBS) }];
}

async function prepareCollect(connection: Connection, product: Product): Promise<Phase[]> {
  const { db, sql } = connection;
  const [channel] = await sql<{ id: string }[]>`select id from channels where family = 'ats' order by id limit 1`;
  if (!channel) throw new Error("The template needs a seeded ATS channel");
  const rows = await sql<{ id: number; external_id: string; url: string; name: string; title: string; description: string; city: string | null; country: string | null }[]>`
    select distinct on (j.id) j.id::int as id, r.external_id, r.url, c.name, j.title, j.description,
      j.locations_json #>> '{0,city}' as city, j.locations_json #>> '{0,countryCode}' as country
    from job_sources s join raw_postings r on r.id = s.raw_posting_id
    join jobs j on j.id = s.job_id join companies c on c.id = j.company_id
    where s.channel_id = ${channel.id} and j.description is not null and r.url is not null
    order by j.id, r.id limit ${COLLECTION_POSTINGS / 2}`;
  if (rows.length !== COLLECTION_POSTINGS / 2) throw new Error("The template has too few collection postings");
  await stageHeartbeat(connection, product, COLLECTION_HEARTBEATS, rows.map(({ id }) => id));
  const [{ observed_at }] = await sql<{ observed_at: number }[]>`
    select (extract(epoch from max(last_seen_at)) * 1000)::float8 as observed_at from jobs`;
  const fetchedAt = new Date(observed_at + 2_000);
  const items = rows.flatMap((row) => [
    { id: row.external_id, url: row.url, title: `${row.title} (updated)` },
    { id: `agent-changes-fixture-${row.id}`, url: `https://example.test/perf/${row.id}`, title: `Performance fixture ${row.id}` },
  ].map(({ id, url, title }) => {
    const payload: FixturePosting = { id, url, title, company: row.name, description: row.description, city: row.city, country: row.country, remote: false, posted_at: null };
    return { externalId: id, url, payload };
  }));
  const registry = new product.registry.ChannelRegistry();
  product.fixture.registerFixtureChannel(registry, { id: channel.id, family: "ats", kind: "ats" });
  return [{ name: "collect", work: async () => {
    const stored = await product.raw.upsertRawPostings(db, { channelId: channel.id, runId: null, items, fetchedAt });
    const parsed = await product.pipeline.runPipeline(db, { registry, config: product.pipelineConfig, relist: product.pipeline.REPLAY_RELIST, logger: product.logger });
    if (stored.inserted !== rows.length || stored.changed !== rows.length || parsed.parsed !== items.length || parsed.updated !== rows.length) {
      throw new Error(`Incomplete collection fixture: ${JSON.stringify({ stored, parsed })}`);
    }
    const seen = seenDetails(await product.jobs.touchJobsSeen(db, product.sightings), COLLECTION_HEARTBEATS);
    return { ...seen, postings_inserted: stored.inserted, postings_updated: stored.changed, jobs_created: parsed.created, jobs_updated: parsed.updated, jobs_matched: parsed.parsed - parsed.created - parsed.updated };
  } }];
}

async function prepareCompanyMerge({ db, sql }: Connection, product: Product): Promise<Phase[]> {
  const [from, into] = await sql<{ id: number; name_norm: string }[]>`
    select c.id::int as id, c.name_norm from companies c join jobs j on j.company_id = c.id
    group by c.id order by count(*) desc, c.id limit 2`;
  if (!from || !into) throw new Error("The template needs two seeded employers with jobs");
  const moved = await sql`
    with sample as (
      select id from jobs where company_id not in (${from.id}, ${into.id}) order by id limit ${2 * EXTRA_MERGE_JOBS_PER_COMPANY}
    ), ranked as (select id, row_number() over (order by id) as n from sample)
    update jobs j set company_id = case when r.n <= ${EXTRA_MERGE_JOBS_PER_COMPANY} then ${from.id}::bigint else ${into.id}::bigint end
    from ranked r where j.id = r.id`;
  if (moved.count !== 2 * EXTRA_MERGE_JOBS_PER_COMPANY) throw new Error("The template has too few jobs for the merge fixture");
  const [job] = await sql<{ id: number; title_norm: string; seniority: string }[]>`
    select id::int as id, title_norm, seniority from jobs where company_id = ${from.id} order by id limit 1`;
  const key = product.lookup.salaryLookupKey({ companyNorm: from.name_norm, titleNorm: job.title_norm, seniority: job.seniority, location: null }, null);
  await sql`insert into salary_lookups (company_id, job_id, lookup_key, status, result_json, prompt_version, expires_at)
    values (${from.id}, ${job.id}, ${key}, 'done', '{}', 'fixture', now() + interval '1 day')`;
  await sql`insert into company_research (company_id, job_id, status, result_json, prompt_version, expires_at)
    values (${from.id}, ${job.id}, 'ok', '{}', 1, now() + interval '1 day')`;
  const context: CompanyMergeContext = { pipeline: product.pipelineConfig, watchedCompanies: [], excludedCompanies: [], trustedKeys: [] };
  let mergeId: number;
  const details = (plan: { jobs: number; salaryLookups: number; research: number }) => ({ jobs_moved: plan.jobs, salary_lookups_moved: plan.salaryLookups, company_research_moved: plan.research });
  return [
    { name: "merge", work: async () => {
      const merged = await db.transaction((tx) => product.merges.applyCompanyMerge(tx, from.id, into.id, context));
      mergeId = merged.mergeId;
      return details(merged.plan);
    } },
    { name: "undo", work: async () => {
      const undone = await db.transaction((tx) => product.merges.undoCompanyMerge(tx, mergeId));
      return details(undone.plan);
    } },
  ];
}

async function prepareTrapRescan({ db, sql }: Connection, product: Product): Promise<Phase[]> {
  const [{ n: jobCount }] = await sql<{ n: number }[]>`select count(*)::int as n from jobs`;
  const settings = product.loadConfig("traps");
  const options = { settings, channels: { get: () => undefined }, logger: product.logger, force: true };
  const flagged = await sql<{ id: number }[]>`
    update jobs set description = description || ${"\nPer\u200B\u200Bformance fixture"}
    where id % 100 = 0 returning id::int as id`;
  const fixture = await product.traps.runTrapScan(db, { ...options, limit: flagged.length, jobIds: flagged.map(({ id }) => id) });
  if (fixture.scanned !== flagged.length || fixture.failed !== 0 || fixture.withTraps + fixture.withSuspicious !== flagged.length) {
    throw new Error("Could not seed the prior trap results");
  }
  await sql`update jobs set description = description || ${" updated"} where id % 100 = 0`;
  return [{ name: "trap_rescan", work: async () => {
    let afterId = 0;
    let jobsScanned = 0;
    let findingsChanged = 0;
    for (;;) {
      const ids = await product.trapRepo.listAllJobIds(db, { afterId, limit: TRAP_BATCH });
      if (ids.length === 0) break;
      const result = await product.traps.runTrapScan(db, { ...options, limit: ids.length, jobIds: ids });
      if (result.scanned !== ids.length || result.failed !== 0) throw new Error(`Incomplete trap scan after job ${afterId}: scanned ${result.scanned}, failed ${result.failed}`);
      jobsScanned += result.scanned;
      findingsChanged += result.changed;
      afterId = ids[ids.length - 1]!;
    }
    if (jobsScanned !== jobCount) throw new Error(`Expected ${jobCount} trap scans, processed ${jobsScanned}`);
    return { jobs_scanned: jobsScanned, jobs_with_changed_findings: findingsChanged };
  } }];
}

async function prepareBenchmarkRebuild({ db, sql }: Connection, product: Product): Promise<Phase[]> {
  const currency = product.pipelineConfig.market.currency;
  await sql`
    update jobs set salary_json = salary_json || jsonb_build_object('baseCurrency', ${currency}::text, 'basePerYear', salary_json #> array['base', ${currency}::text])
    where not (salary_json ?| array['basePerYear', 'eurPerYear']) and jsonb_typeof(salary_json #> array['base', ${currency}::text]) = 'object'`;
  const families = product.families.compileFamilies([{ id: "engineering", label: { en: "Engineering" }, patterns: ["\\bengineer\\b"] }]);
  const postings = await product.salaryRepo.listSalaryFigures(db, { currency, since: new Date(0) });
  const input = { postings, families, currency, minSample: product.loadConfig("salary").benchmark.min_sample };
  const rows = product.salary.buildBenchmarkRows(input);
  const city = rows.filter((row) => row.geoLevel === "city").sort((a, b) => b.n - a.n)[0];
  if (!city) throw new Error("The template needs a city with enough comparable salary figures");
  const keysFor = (title: string, seniority: string, city: string | null, country: string | null) => {
    const family = families.familyOf(title);
    return family === null ? [] : product.salary.groupKeys({ family, seniority: seniority.toLowerCase(), city, country }).map((key) => ({ ...key, roleFamily: family, currency }));
  };
  const keyOf = (row: Pick<SalaryBenchmarkInput, "roleFamily" | "seniority" | "geoLevel" | "geoKey" | "currency">) =>
    JSON.stringify([row.roleFamily, row.seniority, row.geoLevel, row.geoKey, row.currency]);
  const selected = keyOf(city);
  const changedRows = product.salary.buildBenchmarkRows({ ...input, postings: postings.map((row) =>
    keysFor(row.title, row.seniority, row.location?.city ?? null, row.location?.countryCode ?? null).some((key) => keyOf(key) === selected)
      ? { ...row, figure: row.figure + 10_000 }
      : row,
  ) });
  const baseline = new Map(rows.map((row) => [keyOf(row), JSON.stringify([row.n, Math.round(row.median * 100), row.quantiles])]));
  const changedKeys = new Set(changedRows.filter((row) => baseline.get(keyOf(row)) !== JSON.stringify([row.n, Math.round(row.median * 100), row.quantiles])).map(keyOf));
  const jobs = await sql<{ title: string; seniority: string; city: string | null; country: string | null }[]>`
    select title, seniority, locations_json #>> '{0,city}' as city, locations_json #>> '{0,countryCode}' as country from jobs`;
  const matchingJobs = jobs.filter((job) => keysFor(job.title, job.seniority, job.city, job.country).some((key) => changedKeys.has(keyOf(key)))).length;
  await product.salaryRepo.replaceSalaryBenchmarks(db, rows);
  return [
    { name: "identical", work: async () => {
      await product.salaryRepo.replaceSalaryBenchmarks(db, rows);
      return { groups: rows.length, changed_groups: 0, matching_jobs_estimate: 0 };
    } },
    { name: "changed", work: async () => {
      await product.salaryRepo.replaceSalaryBenchmarks(db, changedRows);
      return { groups: changedRows.length, changed_groups: changedKeys.size, matching_jobs_estimate: matchingJobs };
    } },
  ];
}

async function runTrial(admin: Sql, url: URL, template: string, product: Product, prepare: Prepare, mode: Mode): Promise<Trial> {
  const copy = checkedDatabase(`jobradar_test_scoreperf_${randomUUID().replaceAll("-", "")}`);
  await admin.unsafe(`create database "${copy}" template "${template}"`);
  try {
    const target = new URL(url);
    target.pathname = `/${copy}`;
    target.searchParams.set("synchronous_commit", "on");
    const connection = product.client.createConnection(target.toString(), { max: 1 });
    try {
      const triggers = await readAgentTriggers(connection.sql, product.sync.SYNC_SOURCES);
      const phases = await prepare(connection);
      if (mode === "off") {
        for (const trigger of triggers) await connection.sql.unsafe(trigger.turn_off);
      }
      const samples: Trial["phases"] = {};
      const totals: Metrics = { ms: 0, wal_bytes: 0, change_rows: 0 };
      for (const phase of phases) {
        const sample = await measure(connection.sql, phase.work);
        samples[phase.name] = sample;
        for (const metric of METRICS) totals[metric] += sample[metric];
      }
      return { ...totals, phases: samples };
    } finally {
      await connection.sql.end({ timeout: 5 });
    }
  } finally {
    await admin.unsafe(`drop database "${copy}" with (force)`);
  }
}

function median(values: number[]) {
  const sorted = values.sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2;
}

function summarize<T extends Metrics>(off: T[], on: T[], expectZeroChanges: boolean) {
  const metrics = (runs: T[]): Metrics => ({
    ms: median(runs.map((run) => run.ms)),
    wal_bytes: median(runs.map((run) => run.wal_bytes)),
    change_rows: median(runs.map((run) => run.change_rows)),
  });
  const before = metrics(off);
  const after = metrics(on);
  const increase = (before: number, after: number) => before === 0 ? (after === 0 ? 0 : null) : 100 * (after - before) / before;
  const time = increase(before.ms, after.ms);
  const wal = increase(before.wal_bytes, after.wal_bytes);
  const changeRowsPass = off.every((run) => run.change_rows === 0) && (!expectZeroChanges || on.every((run) => run.change_rows === 0));
  return {
    off: { median: before, runs: off }, on: { median: after, runs: on },
    time_increase_pct: time, wal_increase_pct: wal, change_rows_pass: changeRowsPass,
    pass: changeRowsPass && time !== null && time <= TIME_LIMIT_PCT && wal !== null && wal <= WAL_LIMIT_PCT,
  };
}

async function runBenchmark(admin: Sql, url: URL, template: string, product: Product, runs: number, out: string, label: string) {
  const scenarios: Record<string, Prepare> = {
    rescore: (connection) => prepareRescore(connection, product),
    collect: (connection) => prepareCollect(connection, product),
    heartbeat: (connection) => prepareHeartbeat(connection, product),
    company_merge: (connection) => prepareCompanyMerge(connection, product),
    trap_rescan: (connection) => prepareTrapRescan(connection, product),
    benchmark_rebuild: (connection) => prepareBenchmarkRebuild(connection, product),
  };
  const results: Record<string, ReturnType<typeof summarize<Trial>> & { phases: Record<string, ReturnType<typeof summarize<Sample>>> }> = {};
  for (const [scenario, prepare] of Object.entries(scenarios)) {
    const trials: Record<Mode, Trial[]> = { off: [], on: [] };
    for (let run = 0; run < runs; run += 1) {
      for (const mode of MODES) {
        console.log(`${scenario} ${mode} ${run + 1}/${runs}`);
        trials[mode].push(await runTrial(admin, url, template, product, prepare, mode));
      }
    }
    const phases: (typeof results)[string]["phases"] = {};
    const zeroRows = scenario === "heartbeat";
    for (const name of Object.keys(trials.off[0]!.phases)) {
      phases[name] = summarize(trials.off.map((run) => run.phases[name]), trials.on.map((run) => run.phases[name]), zeroRows || name === "identical");
    }
    const total = summarize(trials.off, trials.on, zeroRows);
    results[scenario] = { ...total, phases, pass: total.pass && Object.values(phases).every((phase) => phase.pass) };
  }

  const file = path.join(out, `agent-changes-writes-${label}.json`);
  await fs.writeFile(file, `${JSON.stringify(results, null, 2)}\n`);
  const pct = (value: number | null) => value === null ? "n/a" : value.toFixed(1);
  const table = Object.entries(results).flatMap(([name, total]) => {
    const entries = Object.entries(total.phases);
    const rows = [[name, total] as const, ...(entries.length > 1 ? entries.map(([phase, comparison]) => [`${name}/${phase}`, comparison] as const) : [])];
    return rows.map(([row, result]) => [row, {
      "ms off/on": `${result.off.median.ms.toFixed(1)} / ${result.on.median.ms.toFixed(1)}`,
      "WAL bytes off/on": `${result.off.median.wal_bytes} / ${result.on.median.wal_bytes}`,
      "rows off/on": `${result.off.median.change_rows} / ${result.on.median.change_rows}`,
      "time %": pct(result.time_increase_pct), "WAL %": pct(result.wal_increase_pct), pass: result.pass,
    }]);
  });
  console.table(Object.fromEntries(table));
  console.log(file);
  if (Object.values(results).some((result) => !result.pass)) process.exitCode = 1;
}

const { out, args } = outputArgs(process.argv.slice(2));
const parsed = parseArgs({ args, options: { runs: { type: "string" } }, allowPositionals: true });
const usage = "Usage: agent-changes-writes.mts ADMIN_URL TEMPLATE_DB CODE_ROOT LABEL --out OUT_DIR [--runs N]";
const positionals = z.tuple([z.string(), z.string(), z.string().min(1), z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)]);
const [adminUrl, templateName, codeRoot, label] = positionals.parse(parsed.positionals, { error: () => usage });
const runs = z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.int().positive()).parse(parsed.values.runs ?? "3");
if (!URL.canParse(adminUrl)) throw new Error("Expected a PostgreSQL admin URL");
const url = checkedUrl(adminUrl);
const template = checkedDatabase(templateName);
const root = path.resolve(codeRoot);
const scratch = await fs.mkdtemp(path.join(tmpdir(), "agent-changes-writes-"));
const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
try {
  process.env.JOB_RADAR_DEFAULTS_DIR = path.join(root, "config");
  process.env.JOB_RADAR_CONFIG_DIR = scratch;
  process.env.JOB_RADAR_PROFILE_DIR = scratch;
  process.env.JOB_RADAR_CONFIG_POLL_MS = "0";
  await runBenchmark(admin, url, template, await loadProduct(root), runs, out, label);
} finally {
  await admin.end({ timeout: 5 });
  await fs.rm(scratch, { recursive: true, force: true });
}

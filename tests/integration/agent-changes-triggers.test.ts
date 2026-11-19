import { eq, sql, type SQL } from "drizzle-orm";
import { afterAll, expect, inject, it } from "vitest";

import { BREAKDOWN_PROMPT_VERSION } from "@/lib/ai/prompts/breakdown";
import { SALARY_PROMPT_VERSION } from "@/lib/ai/prompts/salary";
import { loadConfig } from "@/lib/config";
import { createConnection } from "@/lib/db/client";
import type { Executor } from "@/lib/db/executor";
import { revertApplicationStatus, setApplicationStatus } from "@/lib/db/repos/applications";
import { clearClosureOverride, setClosureOverride } from "@/lib/db/repos/closures";
import { applyCompanyMerge, undoCompanyMerge } from "@/lib/db/repos/company-merges";
import { mergeCompanyInto } from "@/lib/db/repos/companies";
import { addFavorite, removeFavorite } from "@/lib/db/repos/favorites";
import { clearFilterOverride, setFilterOverride } from "@/lib/db/repos/filter-overrides";
import { touchJobsSeen } from "@/lib/db/repos/jobs";
import { markSeen, markUnseen } from "@/lib/db/repos/seen";
import { listJobsToTrapScan } from "@/lib/db/repos/traps";
import * as schema from "@/lib/db/schema";
import { SYNC_BLOCKS, SYNC_REMOVED_BITS, SYNC_SOURCES, type SyncBlock, type SyncKeyKind, type SyncOperation } from "@/lib/db/sync-sources";
import { salaryLookupKey } from "@/lib/salary/lookup-key";
import type { SalaryLookupResult } from "@/lib/salary/lookup-types";
import { cleanDescriptionStrict } from "@/lib/traps/clean";
import { rulesFingerprint } from "@/lib/traps/fingerprint";

import { pipelineWith } from "../pipeline/helpers";

const connection = createConnection(inject("testDatabaseUrl"), { max: 2 });
afterAll(async () => { await connection.sql.end({ timeout: 5 }); });

const first = new Date("2026-05-01T08:00:00Z");
const dormantAt = new Date("2026-05-01T09:00:00Z");
const later = new Date("2026-05-01T10:00:00Z");
const description = "Build reliable services. Serve requests.";
const jobBlockNames = (Object.keys(SYNC_BLOCKS) as SyncBlock[]).filter((block) => SYNC_BLOCKS[block].entity === "job");
const freshnessBlocks = ["job", "translation", "breakdown", "salary", "company", "ghost", "match"] as const;

const mask = (blocks: readonly SyncBlock[]) => blocks.reduce((bits, block) => bits | (1 << SYNC_BLOCKS[block].bit), 0);
const removed = (kind: keyof typeof SYNC_REMOVED_BITS) => 1 << SYNC_REMOVED_BITS[kind];
const change = (keyKind: SyncKeyKind, key: string | number, blocks: readonly SyncBlock[], removedBits = 0) =>
  ({ keyKind, key: String(key), blocks: mask(blocks), removed: removedBits });

async function readChanges(db: Executor = connection.db) {
  const { keyKind, key, blocks, removed, seq } = schema.agentChanges;
  const rows = await db.select({ keyKind, key, blocks, removed }).from(schema.agentChanges).orderBy(seq);
  return rows.map((row) => row.keyKind === "benchmark" && row.key !== "*"
    ? { ...row, key: JSON.stringify(JSON.parse(row.key)) }
    : row);
}

const clearChanges = (db: Executor = connection.db) => db.delete(schema.agentChanges);

async function seedJobs(db: Executor, dormant = false) {
  const [from, into] = await db.insert(schema.companies).values([
    { name: "Example Engineering", nameNorm: "example engineering", websiteDomain: "example.invalid" },
    { name: "Other Engineering", nameNorm: "other engineering", websiteDomain: "other.invalid" },
  ]).returning();
  const [primary, spare, sibling] = await db.insert(schema.jobs).values([
    { companyId: from!.id, title: "Engineer", titleNorm: "engineer", description, firstSeenAt: first, lastSeenAt: first,
      status: dormant ? "possibly_closed" : "active", dormantAt: dormant ? dormantAt : null },
    { companyId: into!.id, title: "Engineer", titleNorm: "engineer", description, firstSeenAt: first, lastSeenAt: first },
    { companyId: from!.id, title: "Engineer", titleNorm: "engineer", description, firstSeenAt: first, lastSeenAt: first },
  ]).returning();
  return { from: from!, into: into!, primary: primary!, spare: spare!, sibling: sibling! };
}

async function seedSources(db: Executor, jobId: number) {
  await db.insert(schema.channels).values([
    { id: "primary", family: "ats", kind: "ats" },
    { id: "secondary", family: "board", kind: "board" },
  ]);
  const [raw, alternate] = await db.insert(schema.rawPostings).values([
    { channelId: "primary", externalId: "primary", payloadJson: { description }, fetchedAt: first },
    { channelId: "secondary", externalId: "secondary", payloadJson: { description }, fetchedAt: first },
  ]).returning();
  const [source] = await db.insert(schema.jobSources).values({
    jobId, rawPostingId: raw!.id, channelId: "primary", url: "https://example.invalid/job", firstSeenAt: first,
  }).returning();
  return { raw: raw!, alternate: alternate!, source: source! };
}

const lookupResult: SalaryLookupResult = {
  query: { company: "Example Engineering", title: "Engineer", city: null, country: null, seniority: "unknown", currency: "EUR" },
  companyLevel: { level: "unknown", median: null, summary: "", sources: [] },
  roleBand: null, relatedRoles: [], sources: [], confidence: "low", notes: "", dropped: 0, observations: [],
};

async function seedResearch(db: Executor, company: { id: number; nameNorm: string }, jobId: number) {
  const lookupKey = salaryLookupKey({ companyNorm: company.nameNorm, titleNorm: "engineer", seniority: "unknown", location: null }, null);
  const [lookup] = await db.insert(schema.salaryLookups).values({
    companyId: company.id, jobId, lookupKey, status: "done", resultJson: lookupResult, promptVersion: SALARY_PROMPT_VERSION, fetchedAt: first, expiresAt: later,
  }).returning();
  const [research] = await db.insert(schema.companyResearch).values({
    companyId: company.id, jobId, status: "ok", resultJson: { fields: {}, dropped: 0 }, promptVersion: 1, fetchedAt: first, expiresAt: later,
  }).returning();
  return { lookup: lookup!, research: research! };
}

async function matrixFixture(db: Executor) {
  const { primary, from, into, spare, sibling } = await seedJobs(db, true);
  const { raw, alternate, source } = await seedSources(db, primary.id);
  const { lookup, research } = await seedResearch(db, from, primary.id);
  const jobId = primary.id;
  await db.update(schema.jobs).set({ linkCheckJson: {
    outcome: "alive", at: first.toISOString(), url: null, httpStatus: null, phrase: null, quote: null,
  } }).where(eq(schema.jobs.id, jobId));
  const [signal] = await db.insert(schema.signals).values({ jobId, tier: "pay", kind: "mention", quote: "Build reliable services.", extractor: "rule" }).returning();
  await db.insert(schema.trapScans).values({ jobId, descriptionHash: "description", sourcesHash: "sources", rulesHash: "rules", trapCount: 1 });
  const [trap] = await db.insert(schema.jobTraps).values({
    jobId, layer: "rule", technique: "instruction", severity: "trap", quote: "Build reliable services.", quoteSource: "description",
    quoteOffset: 0, location: "description", inDescription: true,
  }).returning();
  await db.insert(schema.translations).values({ jobId, lang: "en", content: "Stored translation.", sourceHash: "translation", createdAt: first });
  const breakdown = {
    responsibilities: [], tech_stack: [], experience: { years_min: null, years_quote: null, items: [] },
    projects: [], soft_skills: [], languages: [], other: [],
  };
  await db.insert(schema.jobBreakdowns).values({ jobId, sourceHash: "breakdown", promptVersion: BREAKDOWN_PROMPT_VERSION, outputLang: "en", content: breakdown, analyzedAt: first });
  const ghostReason = { code: "long_open", points: 5, days: 20, since: "2026-05-01", from: "first_seen", channelId: null };
  await db.insert(schema.jobGhost).values({
    jobId, level: "watch", score: 5, inputHash: "ghost", evidence: [ghostReason], dismissedAt: first, dismissedCodes: ["long_open"],
  });
  const [score] = await db.insert(schema.scores).values({
    jobId, filterResult: "passed", score: 60, rankValue: 60, fitReasons: ["Fit"], gaps: ["Gap"], createdAt: first,
  }).returning();
  await db.insert(schema.jobCurrentScores).values({
    jobId, newestScoreId: score!.id, filterResult: "passed", filterReasons: [], rankValue: 60, signalBonus: 0, stale: false,
  });
  await db.insert(schema.jobVisa).values({
    jobId, status: "offered", inputHash: "visa", evidence: [{ status: "offered", kind: null, quote: "Build reliable services.", offset: 0 }],
  });
  const [app, otherApp] = await db.insert(schema.applications).values([
    { jobId, status: "applied", notesMd: "Application note", createdAt: first, statusChangedAt: first },
    { jobId: sibling.id, status: "interested", createdAt: first },
  ]).returning();
  const [event] = await db.insert(schema.applicationEvents).values({
    applicationId: app!.id, toStatus: "applied", note: "Event note", at: first,
  }).returning();
  await db.insert(schema.jobFavorites).values({ jobId, note: "Favorite note", createdAt: first });
  await db.insert(schema.jobSeen).values({ jobId, via: "detail" });
  await db.insert(schema.jobFilterOverrides).values({ jobId, action: "keep" });
  await db.insert(schema.jobClosureOverrides).values({ jobId, action: "open", createdAt: first });
  const [benchmark] = await db.insert(schema.salaryBenchmarks).values({
    roleFamily: "engineering", seniority: "mid", geoLevel: "city", geoKey: "example", currency: "EUR", n: 8, median: 80000, quantiles: [70000, 90000],
  }).returning();

  const byId = (id: number) => sql`id = ${id}`;
  const job = sql`job_id = ${jobId}`;
  const move = sql`${spare.id}`;
  const time = sql`${later.toISOString()}::timestamptz`;
  const id = sql`default`;
  return {
    applicationJobs: new Map([[app!.id, jobId], [otherApp!.id, sibling.id]]),
    inputs: {
      jobs: { where: byId(jobId), values: {
        title: sql`'Principal engineer'`, title_norm: sql`'principal-engineer'`, company_id: sql`${into.id}`,
        locations_json: sql`'[{"label":"Example City","city":"Example City","countryCode":"DE","isPrimary":true}]'::jsonb`,
        workplace: sql`'remote'`, contract: sql`'permanent'`, is_agency: sql`true`, language: sql`'en'`,
        german_level_required: sql`'B2'`, skills: sql`array['TypeScript']`, posted_at: time, first_seen_at: time,
        salary_json: sql`'{"raw":"80000 EUR","currency":"EUR","min":80000,"max":null,"period":"year","perYear":{"min":80000,"max":null},"periodAssumed":false,"origin":"text","qualityStatus":"valid","reasonCodes":[]}'::jsonb`,
        seniority: sql`'senior'`,
        description: sql`'New posting text.'`, description_md5: sql`md5('different posting')`, status: sql`'active'`,
        dormant_at: sql`null`, last_seen_at: time, link_check_json: sql`jsonb_set(link_check_json, '{outcome}', '"phrase"')`,
        relisted_at: time, relist_count: sql`1`,
      } },
      job_sources: { where: byId(source.id), values: {
        id, job_id: move, raw_posting_id: sql`${alternate.id}`, channel_id: sql`'secondary'`, url: sql`'https://example.invalid/new'`,
        apply_url: sql`'https://example.invalid/apply'`, priority: sql`1`, first_seen_at: time,
      } },
      raw_postings: { where: byId(raw.id), values: {
        payload_fingerprint: sql`md5('new fingerprint')`, payload_hash: sql`md5('new hash')`, payload_json: sql`'{"description":"Changed"}'::jsonb`,
      } },
      signals: { where: byId(signal!.id), values: {
        id, job_id: move, tier: sql`'benefit'`, kind: sql`'amount'`, value_json: sql`'{"currency":"EUR","amount":80000}'::jsonb`,
        quote: sql`'Serve requests.'`, quote_offset: sql`25`, quote_source: sql`'structured'`, extractor: sql`'ai'`,
      } },
      trap_scans: { where: job, values: {
        job_id: move, description_hash: sql`'new description'`, sources_hash: sql`'new sources'`, rules_hash: sql`'new rules'`,
        trap_count: sql`2`, suspicious_count: sql`1`,
      } },
      job_traps: { where: byId(trap!.id), values: {
        id, job_id: move, quote: sql`'Serve requests.'`, quote_offset: sql`25`, technique: sql`'invisible_unicode'`,
        method: sql`'tag_chars'`, in_description: sql`false`,
      } },
      translations: { where: job, values: {
        job_id: move, lang: sql`'fr'`, content: sql`'New translation.'`, source_hash: sql`'new hash'`, created_at: time,
      } },
      job_breakdowns: { where: job, values: {
        job_id: move, content: sql`${JSON.stringify({ ...breakdown, responsibilities: [{ text: "Serve requests", quote: "Serve requests.", offset: 25 }] })}::jsonb`,
        prompt_version: sql`'unrecognized prompt version'`, analyzed_at: time,
      } },
      job_ghost: { where: job, values: {
        job_id: move, level: sql`'likely'`, score: sql`7`, evidence: sql`${JSON.stringify([{ ...ghostReason, days: 21 }])}::jsonb`,
        dismissed_at: sql`null`, dismissed_codes: sql`array[]::text[]`,
      } },
      scores: { where: byId(score!.id), values: {
        id, job_id: move, score: sql`72`, rank_value: sql`73`, stale: sql`true`, german_level: sql`'B2'`, ai_score: sql`75`,
        german_penalty: sql`3`, filter_result: sql`'filtered_out'`, filter_reasons: sql`array['Example filter']`,
        fit_reasons: sql`array['Another fit']`, gaps: sql`array['Another gap']`,
        reason_evidence: sql`'{"v":1,"fit":[{"basis":"jd","quote":"Serve requests.","offset":25}],"gaps":[{"basis":"unstated","quote":null,"offset":null}]}'::jsonb`,
        summaries: sql`'{"en":"New summary"}'::jsonb`, summary_zh: sql`'Legacy Chinese summary'`, summary_en: sql`'Legacy English summary'`,
        output_lang: sql`'en'`, scored_at: time, created_at: time,
      } },
      job_current_scores: { where: job, values: { job_id: move, rank_value: sql`71` } },
      job_visa: { where: job, values: {
        job_id: move, status: sql`'not_offered'`, evidence: sql`'[{"status":"offered","kind":null,"quote":"Serve requests.","offset":25}]'::jsonb`,
      } },
      applications: { where: byId(app!.id), values: {
        job_id: move, status: sql`'interviewing'`, status_changed_at: time, next_action: sql`'Follow up'`,
        next_action_at: time, interview_rounds: sql`1`, created_at: time, notes_md: sql`'Changed note'`,
      } },
      application_events: { where: byId(event!.id), values: {
        id, application_id: sql`${otherApp!.id}`, at: time, from_status: sql`'interested'`, to_status: sql`'interviewing'`,
        occurred_at: time, reference: sql`'receipt reference'`, note: sql`'Updated event note'`,
      } },
      job_favorites: { where: job, values: { job_id: move, created_at: time, note: sql`'Updated favorite note'` } },
      job_seen: { where: job, values: { job_id: move } },
      job_filter_overrides: { where: job, values: { job_id: move, action: sql`'exclude'` } },
      job_closure_overrides: { where: job, values: { job_id: move, action: sql`'closed'`, created_at: time } },
      companies: { where: byId(from.id), values: { name: sql`'Renamed Engineering'`, name_norm: sql`'renamed engineering'` } },
      salary_lookups: { where: byId(lookup.id), values: {
        id, lookup_key: sql`'new salary key'`, status: sql`'failed'`, result_json: sql`${JSON.stringify({ ...lookupResult, notes: "Updated notes" })}::jsonb`, fetched_at: time,
        expires_at: sql`expires_at + interval '1 day'`, prompt_version: sql`'next'`,
      } },
      salary_benchmarks: { where: byId(benchmark!.id), values: {
        role_family: sql`'operations'`, seniority: sql`'senior'`, geo_level: sql`'country'`, geo_key: sql`'other'`, currency: sql`'USD'`,
        n: sql`9`, n_ai: sql`1`, median: sql`81000`, quantiles: sql`'[72000,92000]'::jsonb`,
      } },
      company_research: { where: byId(research.id), values: {
        id, company_id: sql`${into.id}`, status: sql`'failed'`, result_json: sql`'{"fields":{"summary":{"text":"Updated result","sourceUrl":"https://example.invalid/about"}},"dropped":0}'::jsonb`,
        fetched_at: time, expires_at: sql`expires_at + interval '1 day'`,
      } },
    } satisfies Record<string, { where: SQL; values: Record<string, SQL> }>,
  };
}

type Source = (typeof SYNC_SOURCES)[number];
type StoredRow = Record<string, unknown>;
const updateSources = SYNC_SOURCES.filter((source) => source.operations.includes("update"));
const tables = Array.from(new Set(updateSources.map((source) => source.table)));

function keyFor(source: Source, row: StoredRow, applicationJobs: ReadonlyMap<number, number>) {
  const key = source.key;
  if ("via" in key) return String(applicationJobs.get(Number(row[key.via])));
  if ("column" in key) return String(row[key.column]);
  if ("columns" in key) return JSON.stringify(key.columns.map((column) => row[column]));
  return key.literal;
}

function expectedChanges(sources: readonly Source[], before: StoredRow, after: StoredRow, applicationJobs: ReadonlyMap<number, number>) {
  const expected = new Map<string, ReturnType<typeof change>>();
  for (const source of sources) {
    const previous = keyFor(source, before, applicationJobs);
    const next = keyFor(source, after, applicationJobs);
    for (const key of new Set([previous, next])) {
      const entry = change(source.key.kind, key, source.blocks);
      const identity = JSON.stringify([entry.keyKind, entry.key]);
      entry.blocks |= expected.get(identity)?.blocks ?? 0;
      if (previous !== next && key === previous) {
        if (source.table === "applications") entry.removed = removed("application");
        if (source.table === "job_favorites") entry.removed = removed("favorite");
      }
      expected.set(identity, entry);
    }
  }
  return [...expected.values()];
}

it.each(tables)("%s records isolated changes to each exported column", async (table) => {
  await connection.db.transaction(async (tx) => {
    const { applicationJobs, inputs } = await matrixFixture(tx);
    await clearChanges(tx);
    const input = (inputs as Record<string, { where: SQL; values: Record<string, SQL> }>)[table]!;
    const sources = updateSources.filter((source) => source.table === table);
    const columns = [...new Set(sources.flatMap((source) => source.columns))];
    expect(Object.keys(input.values).sort()).toEqual(columns.sort());
    const tableName = sql.identifier(table);
    const [stored] = await tx.execute<{ value: StoredRow }>(sql`select to_jsonb(t) as value from ${tableName} t where ${input.where}`);
    for (const column of columns) {
      const columnName = sql.identifier(column);
      const rollback = new Error("restore original source row");
      await expect(tx.transaction(async (rowTx) => {
        if (column !== "id") {
          await rowTx.execute(sql`update ${tableName} set ${columnName} = ${columnName} where ${input.where}`);
          expect(await readChanges(rowTx), `${table}.${column} no-op`).toEqual([]);
        }
        const [updated] = await rowTx.execute<{ value: StoredRow }>(sql`
          update ${tableName} t set ${columnName} = ${input.values[column]} where ${input.where} returning to_jsonb(t) as value`);
        expect(updated?.value[column], `${table}.${column} changed`).not.toEqual(stored!.value[column]);
        const expected = expectedChanges(sources.filter((source) => source.columns.includes(column)), stored!.value, updated!.value, applicationJobs);
        const actual = await readChanges(rowTx);
        expect(actual, `${table}.${column}`).toHaveLength(expected.length);
        expect(actual, `${table}.${column}`).toEqual(expect.arrayContaining(expected));
        throw rollback;
      })).rejects.toBe(rollback);
    }
  });
});

it("keeps the installed trigger operations and UPDATE column checks in sync with the matrix", async () => {
  const triggers = await connection.db.execute<{
    table: string; type: number; enabled: string; predicate: string | null;
    old_table: string | null; new_table: string | null; function_body: string | null;
  }>(sql`
    select c.relname as "table", t.tgtype::int as type, t.tgenabled as enabled,
      t.tgoldtable as old_table, t.tgnewtable as new_table,
      case when t.tgqual is not null then pg_get_triggerdef(t.oid, true) end as predicate,
      case when (t.tgtype::int & 1) = 0 then pg_get_functiondef(t.tgfoid) end as function_body
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal and starts_with(t.tgname, 'agent_change_')`);
  expect(new Set(triggers.map((trigger) => trigger.table))).toEqual(new Set(SYNC_SOURCES.map((source) => source.table)));
  const statementTables = new Set(triggers.filter(({ type }) => (type & 1) === 0).map(({ table }) => table));
  expect(statementTables).toEqual(new Set(["scores"]));
  const flags = { insert: 4, delete: 8, update: 16 } satisfies Record<SyncOperation, number>;
  for (const table of tables) {
    const onTable = triggers.filter((trigger) => trigger.table === table);
    const sources = SYNC_SOURCES.filter((source) => source.table === table);
    const operations = new Set(sources.flatMap((source) => source.operations));
    const statement = statementTables.has(table);
    if (statement) expect(onTable).toHaveLength(operations.size);
    for (const [operation, flag] of Object.entries(flags)) {
      const matches = onTable.filter(({ type }) => type & flag);
      expect(matches, `${table} ${operation}`).toHaveLength(operations.has(operation as SyncOperation) ? 1 : 0);
      for (const { type, enabled, old_table, new_table } of matches) {
        expect(enabled).toBe("O");
        if (statement) {
          expect(type).toBe(flag);
          expect(old_table !== null).toBe(operation !== "insert");
          expect(new_table !== null).toBe(operation !== "delete");
        } else {
          expect(type & 1).toBe(1);
        }
      }
    }
    const update = onTable.find(({ type }) => type & flags.update);
    const comparison = statement ? update?.function_body : update?.predicate;
    expect(comparison, table).toMatch(/is distinct from/i);
    const columnReference = statement ? /\b(?:old_score|new_score)\."?([a-z_][a-z_0-9]*)"?/gi : /\b(?:old|new)\."?([a-z_][a-z_0-9]*)"?/gi;
    const actual = new Set(Array.from(comparison!.matchAll(columnReference), ([, column]) => column));
    expect(actual, table).toEqual(new Set(sources.filter((source) => source.operations.includes("update")).flatMap((source) => source.columns)));
  }
});

it.each(["fingerprint", "membership"] as const)("notifies changes to raw %s even for a dormant job, before any rescan", async (input) => {
  const { db } = connection;
  const { primary, sibling } = await seedJobs(db, true);
  const { raw, alternate, source } = await seedSources(db, primary.id);
  await db.insert(schema.jobSources).values({
    jobId: sibling.id, rawPostingId: raw.id, channelId: raw.channelId, firstSeenAt: first,
  });
  const settings = { ...loadConfig("traps"), enabled: true };
  const rulesHash = rulesFingerprint(settings);
  const ids = [primary.id, sibling.id];
  const candidates = await listJobsToTrapScan(db, { rulesHash, limit: ids.length, jobIds: ids });
  expect(candidates).toHaveLength(2);
  await db.insert(schema.trapScans).values(candidates.map((candidate) => ({
    jobId: candidate.jobId, descriptionHash: candidate.descriptionHash, sourcesHash: candidate.sourcesHash, rulesHash, trapCount: 1,
  })));
  const read = (jobId: number) => cleanDescriptionStrict(db, { jobId, description }, { settings: () => settings });
  for (const id of ids) expect(await read(id)).toMatchObject({ ok: true });
  await clearChanges();
  if (input === "fingerprint") {
    await db.update(schema.rawPostings).set({ payloadFingerprint: "new source fingerprint" }).where(eq(schema.rawPostings.id, raw.id));
    expect(await readChanges()).toEqual([change("raw_posting", raw.id, freshnessBlocks)]);
    expect(await read(sibling.id)).toEqual({ ok: false, reason: "not_scanned" });
  } else {
    await db.update(schema.jobSources).set({ rawPostingId: alternate.id }).where(eq(schema.jobSources.id, source.id));
    expect(await readChanges()).toEqual([change("job", primary.id, freshnessBlocks)]);
    expect(await read(sibling.id)).toMatchObject({ ok: true });
  }
  expect(await read(primary.id)).toEqual({ ok: false, reason: "not_scanned" });
  const scheduled = await listJobsToTrapScan(db, { rulesHash, limit: 10 });
  expect(scheduled.map((candidate) => candidate.jobId)).not.toContain(primary.id);
});

it("ignores unchanged fingerprints, heartbeat writes and non-exported columns", async () => {
  const { db } = connection;
  const { primary } = await seedJobs(db);
  const { raw } = await seedSources(db, primary.id);
  await db.update(schema.rawPostings).set({ payloadHash: "stable hash" }).where(eq(schema.rawPostings.id, raw.id));
  await db.update(schema.jobs).set({ linkCheckJson: {
    outcome: "alive", at: first.toISOString(), url: null, httpStatus: 200, phrase: null, quote: null,
  } }).where(eq(schema.jobs.id, primary.id));
  await db.insert(schema.applications).values({ jobId: primary.id });
  await db.insert(schema.jobGhost).values({ jobId: primary.id, level: "none", score: 0, inputHash: "already checked", checkedAt: first });
  await clearChanges();

  await db.update(schema.rawPostings).set({ fetchedAt: later, payloadJson: { description: "Metadata the stable hash does not include." } }).where(eq(schema.rawPostings.id, raw.id));
  expect(await touchJobsSeen(db, { relistMinGapDays: 14 })).toMatchObject({ seen: 1, reopened: 0, relisted: 0 });
  await db.execute(sql`update jobs set link_check_json = link_check_json || '{"at":"2026-05-01T10:00:00Z","unseenCheckedAt":"2026-05-01T10:00:00Z","httpStatus":204}'::jsonb where id = ${primary.id}`);
  await db.update(schema.applications).set({ resumeVariantPath: "private-variant.pdf" }).where(eq(schema.applications.jobId, primary.id));
  await db.update(schema.jobGhost).set({ checkedAt: later }).where(eq(schema.jobGhost.jobId, primary.id));
  expect(await readChanges()).toEqual([]);
});

it("writes a removal when the first application move is reverted, even with a cascading event note", async () => {
  const { db } = connection;
  const { primary } = await seedJobs(db);
  const app = await setApplicationStatus(db, primary.id, "applied", "Receipt note");
  await clearChanges();

  expect(await revertApplicationStatus(db, primary.id, { movedTo: "applied", restoreTo: "new" })).toMatchObject({ status: null, reverted: true });
  expect(await db.select().from(schema.applicationEvents).where(eq(schema.applicationEvents.applicationId, app.applicationId))).toEqual([]);
  expect(await readChanges()).toEqual([
    change("job", primary.id, ["tracking", "app", "notes", "app.notes"], removed("application")),
  ]);
});

it("writes a favorite removal when unstarred", async () => {
  const { db } = connection;
  const { primary } = await seedJobs(db);
  await addFavorite(db, primary.id);
  await clearChanges();

  await removeFavorite(db, primary.id);
  expect(await readChanges()).toEqual([
    change("job", primary.id, ["tracking", "app", "fav", "fav.notes"], removed("favorite")),
  ]);
});

it("records all removed entities when a job and its application are deleted together", async () => {
  const { db } = connection;
  const { primary } = await seedJobs(db);
  const app = await setApplicationStatus(db, primary.id, "applied", null);
  await addFavorite(db, primary.id);
  await markSeen(db, primary.id, "detail");
  await seedSources(db, primary.id);
  await clearChanges();

  await db.transaction(async (tx) => {
    await tx.delete(schema.applications).where(eq(schema.applications.jobId, primary.id));
    await tx.delete(schema.jobs).where(eq(schema.jobs.id, primary.id));
  });
  expect(await db.select().from(schema.applicationEvents).where(eq(schema.applicationEvents.applicationId, app.applicationId))).toEqual([]);
  const changes = await readChanges();
  expect(changes).toHaveLength(3);
  expect(changes).toEqual(expect.arrayContaining([
    change("job", primary.id, ["tracking", "app", "app.notes"], removed("application")),
    change("job", primary.id, ["fav", "fav.notes"], removed("favorite")),
    change("job", primary.id, jobBlockNames, removed("job")),
  ]));
});

it("logs marking unseen, clearing a closure and clearing a filter override through their repositories", async () => {
  const { db } = connection;
  const { primary } = await seedJobs(db);
  await markSeen(db, primary.id, "detail");
  await setClosureOverride(db, primary.id, "closed", null, first);
  await setFilterOverride(db, primary.id, "keep");
  await clearChanges();

  await markUnseen(db, primary.id);
  await clearClosureOverride(db, primary.id);
  await clearFilterOverride(db, primary.id);
  expect(await readChanges()).toEqual([
    change("job", primary.id, ["tracking", "app"]),
    change("job", primary.id, ["job", "lifecycle", "tracking", "app", "fav"]),
    change("job", primary.id, ["tracking", "app"]),
  ]);
});

it("logs a company rename once without writing a change per job", async () => {
  const { db } = connection;
  const { from } = await seedJobs(db);
  await clearChanges();

  await db.update(schema.companies).set({ name: "Renamed Engineering" }).where(eq(schema.companies.id, from.id));
  expect(await readChanges()).toEqual([change("company", from.id, ["job", "app", "fav"])]);
});

it.each(["planned", "pipeline"] as const)("writes the old and new shared keys during a %s company merge", async (path) => {
  const { db } = connection;
  const { primary, sibling, from, into } = await seedJobs(db);
  const { lookup } = await seedResearch(db, from, primary.id);
  const newKey = salaryLookupKey({ companyNorm: into.nameNorm, titleNorm: primary.titleNorm, seniority: primary.seniority, location: null }, null);
  const expected = [
    change("company", from.id, ["company"]),
    change("company", into.id, ["company"]),
    change("salary_key", lookup.lookupKey, ["salary"]),
    change("salary_key", newKey, ["salary"]),
    ...[primary.id, sibling.id].map((id) => change("job", id, ["job", "salary", "company", "ghost", "match", "app", "fav"])),
  ];
  const assertChanges = async () => {
    const rows = await readChanges();
    expect(rows).toHaveLength(expected.length);
    expect(rows).toEqual(expect.arrayContaining(expected));
  };
  await clearChanges();

  if (path === "pipeline") {
    expect(await mergeCompanyInto(db, from.id, into.id)).toBe(2);
    await assertChanges();
    return;
  }
  const context = { pipeline: pipelineWith(() => {}), watchedCompanies: [], excludedCompanies: [], trustedKeys: [] };
  const merge = await db.transaction((tx) => applyCompanyMerge(tx, from.id, into.id, context));
  await assertChanges();
  await clearChanges();

  await db.transaction((tx) => undoCompanyMerge(tx, merge.mergeId));
  await assertChanges();
});

it("rolls back changes with a savepoint and uses the top-level transaction id after release", async () => {
  const { db } = connection;
  const { primary, sibling } = await seedJobs(db);
  await clearChanges();

  const transactionId = await db.transaction(async (tx) => {
    const [outer] = await tx.execute<{ tx: string }>(sql`select pg_current_xact_id()::text as tx`);
    await expect(tx.transaction(async (inner) => {
      await inner.update(schema.jobs).set({ language: "en" }).where(eq(schema.jobs.id, sibling.id));
      expect(await readChanges(inner)).toEqual([change("job", sibling.id, ["job"])]);
      throw new Error("roll back this write");
    })).rejects.toThrow("roll back this write");
    expect(await readChanges(tx)).toEqual([]);
    await tx.transaction(async (inner) => {
      await inner.update(schema.jobs).set({ language: "en" }).where(eq(schema.jobs.id, primary.id));
    });
    return outer!.tx;
  });
  expect(await readChanges()).toEqual([change("job", primary.id, ["job"])]);
  expect(await db.select({ tx: schema.agentChanges.tx }).from(schema.agentChanges)).toEqual([{ tx: transactionId }]);
});

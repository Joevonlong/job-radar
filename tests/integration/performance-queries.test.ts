import { randomBytes } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, expect, inject, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { getJob, insertJob, listJobsByCompanyTitle, listJobsForLinkCheck } from "@/lib/db/repos/jobs";
import { listJobsToScan, listJobsToSyncSalary } from "@/lib/db/repos/signals";
import { listJobsToTrapScan } from "@/lib/db/repos/traps";
import { getPushCandidate } from "@/lib/db/repos/notifications";
import { upsertRawPostings } from "@/lib/db/repos/raw-postings";
import { sumAiCostForMonth } from "@/lib/db/repos/ai-usage";
import { getAiUsageForMonth, getMonthRunTotals, listRecentRunsByChannel } from "@/lib/db/queries/sources";
import { oldGetAiUsageForMonth, oldGetMonthRunTotals, oldListRecentRunsByChannel, oldSumAiCostForMonth, oldUpsertRawPostings } from "./performance-baseline";

const client = postgres(inject("testDatabaseUrl"), { max: 1, onnotice: () => {} });
const queries: string[] = [];
const db = drizzle(client, { schema, logger: { logQuery: (query) => { queries.push(query); } } });
afterAll(() => client.end());
beforeEach(() => { queries.length = 0; });

async function job(description: string | null = "Build reliable software.") {
  const [company] = await db.insert(schema.companies).values({ name: "Example", nameNorm: "example" }).returning();
  return insertJob(db, { companyId: company!.id, title: "Engineer", titleNorm: "engineer", description });
}

it("detects signal and trap changes with stored fingerprints, equivalent to the previous SQL", async () => {
  const j = await job();
  await db.insert(schema.channels).values({ id: "fixture", family: "fixture", kind: "manual" });
  const [raw] = await db.insert(schema.rawPostings).values({ channelId: "fixture", externalId: "one", payloadJson: { z: 1, a: "原文" }, payloadHash: null }).returning();
  await db.insert(schema.jobSources).values({ jobId: j.id, rawPostingId: raw!.id, channelId: "fixture" });
  for (const description of ["Build reliable software.", "Changed description", "", null]) {
    await db.update(schema.jobs).set({ description }).where(eq(schema.jobs.id, j.id));
    const baseline = await db.execute<{ id: string }>(sql`select j.id from jobs j left join signal_scans s on s.job_id = j.id
      where j.id > 0 and not (j.status = 'possibly_closed' and j.dormant_at is not null and j.dormant_at > j.last_seen_at)
      and j.description is not null and btrim(j.description) <> ''
      and (s.job_id is null or s.description_hash <> md5(j.description) or s.rules_hash <> 'rules') order by j.id limit 20`);
    queries.length = 0;
    expect((await listJobsToScan(db, { rulesHash: "rules", afterId: 0, limit: 20 })).map((r) => r.id)).toEqual(baseline.map((r) => Number(r.id)));
    await listJobsToSyncSalary(db, { afterId: 0, limit: 20 });
    const traps = await listJobsToTrapScan(db, { rulesHash: "rules", limit: 20 });
    const detectionSql = queries.join("\n");
    const oldTraps = await db.execute<{ id: string; description_hash: string; sources_hash: string; fresh: boolean }>(sql`
      with src as (select js.job_id, md5(coalesce(string_agg(js.raw_posting_id::text || ':' || coalesce(rp.payload_hash, md5(rp.payload_json::text)), ',' order by js.raw_posting_id), '')) as sources_hash
        from job_sources js join raw_postings rp on rp.id = js.raw_posting_id group by js.job_id)
      select j.id, md5(coalesce(j.description, '')) as description_hash, coalesce(src.sources_hash, md5('')) as sources_hash, (ts.job_id is null) as fresh
      from jobs j left join src on src.job_id = j.id left join trap_scans ts on ts.job_id = j.id
      where not (j.status = 'possibly_closed' and j.dormant_at is not null and j.dormant_at > j.last_seen_at)
      and (ts.job_id is null or ts.description_hash <> md5(coalesce(j.description, '')) or ts.sources_hash <> coalesce(src.sources_hash, md5('')) or ts.rules_hash <> 'rules')
      order by (ts.job_id is null) desc, j.first_seen_at desc, j.id desc limit 20`);
    expect(traps).toEqual(oldTraps.map((r) => ({ jobId: Number(r.id), descriptionHash: r.description_hash, sourcesHash: r.sources_hash, fresh: r.fresh })));
    expect(detectionSql).not.toMatch(/md5\((?:coalesce\()?j\.description|md5\((?:coalesce\()?j\.salary_json|rp\.payload_json/);
  }
});

it("keeps unchanged payload TOAST chunks while refreshing metadata and preserving old upsert results", async () => {
  await db.insert(schema.channels).values({ id: "fixture", family: "fixture", kind: "manual" });
  const payload = { text: randomBytes(48_000).toString("hex") };
  const firstAt = new Date("2026-01-01T00:00:00Z");
  const later = new Date("2026-02-01T00:00:00Z");
  await upsertRawPostings(db, { channelId: "fixture", runId: null, fetchedAt: firstAt, items: [{ externalId: "one", url: "https://example.test/old", payload }] });
  await db.update(schema.rawPostings).set({ parseStatus: "parsed" });
  const [table] = await db.execute<{ name: string }>(sql`select reltoastrelid::regclass::text as name from pg_class where oid = 'raw_postings'::regclass`);
  const chunks = async () => Array.from(await db.execute(sql.raw(`select distinct chunk_id::text from ${table!.name} order by 1`)));
  const before = await chunks();
  expect(before.length).toBeGreaterThan(0);
  expect(await upsertRawPostings(db, { channelId: "fixture", runId: null, fetchedAt: later, items: [{ externalId: "one", url: null, payload }] })).toEqual({ inserted: 0, changed: 0, unchanged: 1 });
  expect(await chunks()).toEqual(before);
  const [row] = await db.select().from(schema.rawPostings);
  expect(row).toMatchObject({ payloadJson: payload, fetchedAt: later, url: "https://example.test/old", parseStatus: "parsed", parseError: null });
  await upsertRawPostings(db, { channelId: "fixture", runId: null, items: [{ externalId: "one", url: "https://example.test/new", payload: { text: "changed" } }] });
  expect(await db.select().from(schema.rawPostings)).toMatchObject([{ payloadJson: { text: "changed" }, parseStatus: "pending", url: "https://example.test/new" }]);
  // Compare the complete stored state with the old SQL for unchanged, changed, failed and legacy-null payloads.
  for (const hash of [null, "legacy"]) {
    await db.delete(schema.rawPostings);
    await db.insert(schema.rawPostings).values(["old", "new"].map((externalId) => ({ channelId: "fixture", externalId, payloadJson: { text: "initial" }, payloadHash: hash, parseStatus: "parse_failed" as const, parseError: "failure" })));
    for (const next of [{ text: "initial" }, { text: "initial" }, { text: "changed" }]) {
      const input = { channelId: "fixture", runId: null, fetchedAt: later, items: [{ externalId: "old", url: null, payload: next }] };
      const expected = await oldUpsertRawPostings(db, input);
      const actual = await upsertRawPostings(db, { ...input, items: [{ ...input.items[0]!, externalId: "new" }] });
      expect(actual).toEqual(expected);
      const stored = await db.select().from(schema.rawPostings).orderBy(schema.rawPostings.externalId);
      const facts = stored.map(({ id, externalId, ...row }) => { void [id, externalId]; return row; });
      expect(facts[0]).toEqual(facts[1]);
    }
  }
});

it("reads job facts without transferring the generated search vector", async () => {
  const inserted = await job();
  const [full] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, inserted.id));
  const { searchTsv, descriptionMd5, descriptionHasText, salaryMd5, ...baseline } = full!;
  void [searchTsv, descriptionMd5, descriptionHasText, salaryMd5];
  const rows = [inserted, await getJob(db, inserted.id), ...(await listJobsByCompanyTitle(db, inserted.companyId, inserted.titleNorm)), ...(await listJobsForLinkCheck(db, 5, { unseen: { seenBefore: new Date(), checkedBefore: new Date() } }))];
  for (const row of rows) {
    expect(row).not.toHaveProperty("searchTsv");
    expect(row).toMatchObject(baseline);
  }
  queries.length = 0;
  expect(await getPushCandidate(db, inserted.id)).toMatchObject({ jobId: inserted.id, title: baseline.title });
  expect(queries.join("\n")).not.toContain('"search_tsv"');
});

it("uses bounded channel lookups equivalent to the previous ranked window, including ties and empty channels", async () => {
  await db.insert(schema.channels).values(["a", "b", "empty"].map((id) => ({ id, family: "fixture", kind: "manual" })));
  await db.insert(schema.runs).values(Array.from({ length: 12 }, (_, i) => ({ channelId: i % 2 ? "a" : "b", startedAt: new Date(`2026-01-0${1 + i % 3}T00:00:00Z`), status: "succeeded" as const })));
  for (const n of [0, 1, 3, 20]) {
    const old = await db.execute<{ id: string }>(sql`select id from (select id, channel_id, started_at, row_number() over (partition by channel_id order by started_at desc, id desc) as rank from runs) r where rank <= ${n} order by channel_id, started_at desc, id desc`);
    queries.length = 0;
    const actual = await listRecentRunsByChannel(db, n);
    expect([...actual.values()].flat().map((r) => r.id)).toEqual(old.map((r) => Number(r.id)));
    expect(queries.join("\n")).not.toContain("row_number()");
    expect(actual).toEqual(await oldListRecentRunsByChannel(db, n));
  }
});

it("uses indexable calendar month bounds equivalent to to_char across DST and year boundaries", async () => {
  await db.insert(schema.channels).values({ id: "a", family: "fixture", kind: "manual" });
  const dates = ["2025-12-31T23:00:00Z", "2026-03-01T04:59:59.999Z", "2026-03-01T05:00:00Z", "2026-03-29T00:59:59Z", "2026-03-31T21:59:59.999Z", "2026-03-31T22:00:00Z", "2026-04-01T03:59:59.999Z", "2026-04-01T04:00:00Z", "2026-10-25T01:30:00Z", "2026-11-01T03:59:59.999Z", "2026-11-01T04:00:00Z", "2026-11-01T04:30:00Z", "2026-11-01T05:00:00Z", "2017-10-01T03:59:59Z", "2017-10-01T04:00:00Z", "2009-11-01T03:00:00Z", "2009-11-01T03:01:00Z", "2009-11-01T03:30:00Z", "2009-11-01T04:00:00Z"];
  for (const date of dates) {
    await db.insert(schema.aiUsage).values({ at: new Date(date), provider: "fixture", task: "score", tokensIn: 2, tokensOut: 3, costEstimate: 0.25 });
    await db.insert(schema.runs).values({ channelId: "a", startedAt: new Date(date), status: "succeeded", fetched: 2, newCount: 1 });
  }
  for (const timeZone of ["UTC", "Europe/Berlin", "America/New_York", "Asia/Kathmandu", "America/Havana", "America/Asuncion", "America/Goose_Bay"]) {
    for (const month of ["2026-01", "2026-03", "2026-10", "2026-11", "2027-01", "2017-10", "2009-10", "2009-11"]) {
      const [old] = await db.execute<{ calls: number; cost: string }>(sql`select count(*)::int as calls, coalesce(sum(cost_estimate), 0)::text as cost from ai_usage where provider = 'fixture' and to_char(at at time zone ${timeZone}, 'YYYY-MM') = ${month}`);
      queries.length = 0;
      expect(await sumAiCostForMonth(db, { month, timeZone, providers: ["fixture"] })).toBe(Number(old!.cost));
      const usage = await getAiUsageForMonth(db, { month, timeZone });
      const totals = await getMonthRunTotals(db, { month, timeZone });
      expect(usage[0]?.calls ?? 0).toBe(old!.calls);
      expect(totals.get("a")?.runs ?? 0).toBe(old!.calls);
      expect(queries.join("\n")).not.toContain("to_char");
      expect(usage).toEqual(await oldGetAiUsageForMonth(db, { month, timeZone }));
      expect(totals).toEqual(await oldGetMonthRunTotals(db, { month, timeZone }));
      expect(await sumAiCostForMonth(db, { month, timeZone, providers: ["fixture"] })).toBe(await oldSumAiCostForMonth(db, { month, timeZone, providers: ["fixture"] }));
    }
  }
});

it("provides indexes whose keys match run, notification, pending raw and per-job request predicates", async () => {
  const indexes = await db.execute<{ indexname: string; indexdef: string }>(sql`select indexname, indexdef from pg_indexes where schemaname = 'public'`);
  const definitions = new Map(indexes.map((r) => [r.indexname, r.indexdef]));
  expect(definitions.get("runs_channel_status_started_idx")).toContain("channel_id, status, started_at");
  expect(definitions.get("runs_channel_recent_idx")).toContain("channel_id, started_at DESC, id DESC");
  expect(definitions.get("notifications_job_id_idx")).toContain("payload_json ->> 'jobId'");
  expect(definitions.get("control_requests_job_id_idx")).toContain("payload ->> 'jobId'");
  expect(definitions.get("raw_postings_pending_id_idx")).toMatch(/\(id\).*WHERE.*pending/);
  // Force eligibility rather than a cost choice on these tiny fixtures; the one-year benchmark checks real plans/costs.
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    await tx.execute(sql`set local enable_bitmapscan = off`);
    await tx.execute(sql`set local enable_sort = off`);
    for (const [query, index] of [
      [sql`explain (format json) select id from runs where channel_id = 'fixture' and status = 'succeeded' and started_at >= '2026-01-01'::timestamptz`, "runs_channel_status_started_idx"],
      [sql`explain (format json) select id from runs where channel_id = 'fixture' order by started_at desc, id desc limit 10`, "runs_channel_recent_idx"],
      [sql`explain (format json) select id from runs where started_at >= '2026-01-01'::timestamptz and started_at < '2026-02-01'::timestamptz`, "runs_started_at_idx"],
      [sql`explain (format json) select payload_json->>'jobId' from notifications where kind in ('job', 'job_overflow') and payload_json->>'jobId' = '123'`, "notifications_job_id_idx"],
      [sql`explain (format json) select id from control_requests where kind = 'translate_job' and payload->>'jobId' = '123' order by id desc limit 1`, "control_requests_job_id_idx"],
      [sql`explain (format json) select id from raw_postings where parse_status = 'pending' and id > 0 order by id limit 10`, "raw_postings_pending_id_idx"],
    ] as const) expect(JSON.stringify(await tx.execute(query))).toContain(index);
  });
});

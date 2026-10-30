import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, inject, it } from "vitest";

import { createConnection } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { getJobDetail } from "@/lib/db/queries/job-detail";
import { getJob, insertJob } from "@/lib/db/repos/jobs";
import { listJobsWithRawPostings } from "@/lib/db/repos/job-sources";
import { listPendingRawPostings, listRawPostingsForChannel } from "@/lib/db/repos/raw-postings";
import { setFilterOverride } from "@/lib/db/repos/filter-overrides";
import { trapScanIsCurrent } from "@/lib/db/repos/traps";
import { refilterJob } from "@/lib/filter";
import * as schema from "@/lib/db/schema";
import { makeTempConfig } from "../config/helpers";
import { oldListJobsToTrapScan } from "./performance-baseline";

const url = new URL(inject("testDatabaseUrl"));
const name = `${url.pathname.slice(1)}_upgrade`;
url.pathname = "/postgres";
const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
url.pathname = `/${name}`;
const connection = createConnection(url.toString(), { max: 1 });
const db = connection.db;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-upgrade-"));
const config = makeTempConfig();

beforeAll(async () => {
  await admin.unsafe(`create database "${name}"`);
  fs.cpSync(path.resolve("drizzle"), directory, { recursive: true });
  const journalPath = path.join(directory, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 39);
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 }, url: url.toString(), migrationsFolder: directory });
});

afterAll(async () => {
  await connection.sql.end();
  await admin.unsafe(`drop database if exists "${name}" with (force)`);
  await admin.end();
  fs.rmSync(directory, { recursive: true, force: true });
  config.cleanup();
});

it("reads details, scores and linked raw postings and creates jobs before fingerprint columns exist", async () => {
  const [missing] = await db.execute<{ n: number }>(sql`select count(*)::int as n from information_schema.columns
    where table_schema = 'public' and column_name in ('description_md5', 'description_has_text', 'salary_md5', 'payload_fingerprint', 'filter_input_hash', 'filter_config_hash')`);
  expect(missing?.n).toBe(0);
  await db.execute(sql`insert into companies (name, name_norm) values ('Example', 'example')`);
  await db.execute(sql`insert into channels (id, family, kind) values ('fixture', 'fixture', 'manual')`);
  await db.execute(sql`insert into jobs (company_id, title, title_norm, description) values (1, 'Engineer', 'engineer', 'Build software')`);
  await db.execute(sql`insert into raw_postings (channel_id, external_id, payload_json) values ('fixture', 'one', '{"text":"raw"}')`);
  await db.execute(sql`insert into job_sources (job_id, raw_posting_id, channel_id) values (1, 1, 'fixture')`);
  await db.execute(sql`insert into scores (job_id, filter_result, score, reason_evidence) values (1, 'passed', 75, null)`);
  expect(await getJobDetail(db, 1)).toMatchObject({ id: 1, title: "Engineer", description: "Build software", score: { score: 75, filterResult: "passed" } });
  expect(await getJob(db, 1)).toMatchObject({ id: 1, title: "Engineer" });
  expect(await listPendingRawPostings(db, { afterId: 0, limit: 10 })).toMatchObject([{ id: 1, payloadJson: { text: "raw" } }]);
  expect(await listRawPostingsForChannel(db, "fixture")).toMatchObject([{ id: 1 }]);
  expect(await listJobsWithRawPostings(db, { afterId: 0, limit: 10, includeUnparsed: true })).toMatchObject([{ jobId: 1, sources: [{ raw: { id: 1 } }] }]);
  expect(await insertJob(db, { companyId: 1, title: "Another", titleNorm: "another" })).toMatchObject({ title: "Another" });
  await setFilterOverride(db, 1, "keep");
  expect(await refilterJob(db, 1)).toMatchObject({ filterResult: "passed" });
  await setFilterOverride(db, 1, "exclude");
  expect(await refilterJob(db, 1)).toMatchObject({ filterResult: "filtered_out" });
  await setFilterOverride(db, 1, "keep");
  expect(await refilterJob(db, 1)).toMatchObject({ filterResult: "passed" });
  const [trap] = await oldListJobsToTrapScan(db, { rulesHash: "rules", limit: 1, jobIds: [1] });
  await db.insert(schema.trapScans).values({ jobId: 1, descriptionHash: trap!.descriptionHash, sourcesHash: trap!.sourcesHash, rulesHash: "rules" });
  expect(await trapScanIsCurrent(db, 1, "rules")).toBe(true);
  // The subsequent migration must preserve the heaps and leave old rows for online computation.
  const heaps = () => db.execute<{ relname: string; relfilenode: number }>(sql`select relname, relfilenode from pg_class
    where oid in ('jobs'::regclass, 'raw_postings'::regclass, 'scores'::regclass) order by relname`);
  const before = [...await heaps()];
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 }, url: url.toString() });
  expect([...await heaps()]).toEqual(before);
  expect(await db.select({ hash: schema.jobs.descriptionMd5 }).from(schema.jobs).where(eq(schema.jobs.id, 1))).toEqual([{ hash: null }]);
  expect(await getJobDetail(db, 1)).toMatchObject({ title: "Engineer", score: { score: 75 } });
  expect(await refilterJob(db, 1)).toMatchObject({ filterResult: "passed" });
  expect(await trapScanIsCurrent(db, 1, "rules")).toBe(true);
});

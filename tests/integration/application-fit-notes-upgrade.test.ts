import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, inject, it } from "vitest";

import { aiWorkerRequestKinds } from "@/lib/control/kinds";
import { createConnection } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { claimNextControlRequest, findOpenFitRequest } from "@/lib/db/repos/control-requests";

const url = new URL(inject("testDatabaseUrl"));
const name = `${url.pathname.slice(1)}_fit_upgrade`;
// Only create/drop a sibling of the disposable database supplied by the integration harness.
if (!/^jobradar_test_[a-z0-9_]+$/.test(name)) throw new Error("expected a disposable test database name");
url.pathname = "/postgres";
const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
url.pathname = `/${name}`;
const connection = createConnection(url.toString(), { max: 1 });
const db = connection.db;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-fit-upgrade-"));
let created = false;
const backfill = { lockTimeoutMs: 3000, statementTimeoutMs: 60000 };

async function requestKinds(): Promise<string[]> {
  const rows = await db.execute<{ value: string }>(sql`select unnest(enum_range(null::control_request_kind))::text as value`);
  return rows.map((row) => row.value);
}

beforeAll(async () => {
  await admin.unsafe(`create database "${name}"`);
  created = true;
  fs.cpSync(path.resolve("drizzle"), directory, { recursive: true });
  const journalPath = path.join(directory, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  const at = journal.entries.findIndex((entry) => entry.tag.endsWith("_application_fit_notes"));
  if (at < 1) throw new Error("the fit notes migration is missing");
  journal.entries = journal.entries.slice(0, at);
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  await runMigrations({ currentScoresBackfill: backfill, url: url.toString(), migrationsFolder: directory });
});

afterAll(async () => {
  try {
    await connection.sql.end();
    if (created) await admin.unsafe(`drop database if exists "${name}" with (force)`);
  } finally {
    await admin.end();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("the worker's queries run before the migration adds writer_fit to the enum", async () => {
  expect(await requestKinds()).not.toContain("writer_fit");
  const kinds = aiWorkerRequestKinds("host");
  expect(kinds).toContain("writer_fit");
  expect(await claimNextControlRequest(db, kinds, { lane: "interactive" })).toBeNull();
  expect(await findOpenFitRequest(db, 1)).toBeNull();
});

it("adds the kind and the table next to open requests, and runs again as a no-op", async () => {
  await db.execute(sql`insert into control_requests (kind, payload) values ('translate_job', '{"jobId": 1}'::jsonb)`);
  await runMigrations({ currentScoresBackfill: backfill, url: url.toString() });
  await runMigrations({ currentScoresBackfill: backfill, url: url.toString() });
  expect(await requestKinds()).toContain("writer_fit");
  const tables = await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' and table_name = 'application_fit_notes'`);
  expect(tables).toHaveLength(1);
  expect(await db.execute(sql`select kind::text as kind, status::text as status from control_requests`)).toEqual([{ kind: "translate_job", status: "pending" }]);
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, inject, it } from "vitest";

import { createConnection } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";

const url = new URL(inject("testDatabaseUrl"));
const name = `${url.pathname.slice(1)}_writer_upgrade`;
// Only create/drop a sibling of the disposable database supplied by the integration harness.
if (!/^jobradar_test_[a-z0-9_]+$/.test(name)) throw new Error("expected a disposable test database name");
url.pathname = "/postgres";
const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
url.pathname = `/${name}`;
const connection = createConnection(url.toString(), { max: 1 });
const db = connection.db;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-writer-upgrade-"));
let created = false;
const backfill = { lockTimeoutMs: 3000, statementTimeoutMs: 60000 };

async function requestKinds(): Promise<string[]> {
  const rows = await db.execute<{ value: string }>(sql`select unnest(enum_range(null::control_request_kind))::text as value`);
  return rows.map((row) => row.value);
}

async function writerTables(): Promise<string[]> {
  const rows = await db.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables where table_schema = 'public' and table_name in ('application_questions', 'application_answer_versions') order by table_name`,
  );
  return rows.map((row) => row.table_name);
}

beforeAll(async () => {
  await admin.unsafe(`create database "${name}"`);
  created = true;
  // every migration before the one that adds the application writer
  fs.cpSync(path.resolve("drizzle"), directory, { recursive: true });
  const journalPath = path.join(directory, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  const at = journal.entries.findIndex((entry) => entry.tag.endsWith("_application_writer"));
  if (at < 1) throw new Error("the application writer migration is missing");
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

it("adds the writer tables and request kind next to open requests of other kinds, and runs again as a no-op", async () => {
  expect(await requestKinds()).not.toContain("writer_job");
  expect(await writerTables()).toEqual([]);
  await db.execute(sql`insert into control_requests (kind, payload) values ('translate_job', '{"jobId": 1}'::jsonb)`);

  await runMigrations({ currentScoresBackfill: backfill, url: url.toString() });
  await runMigrations({ currentScoresBackfill: backfill, url: url.toString() });

  expect(await requestKinds()).toContain("writer_job");
  expect(await writerTables()).toEqual(["application_answer_versions", "application_questions"]);
  const open = await db.execute<{ kind: string; status: string }>(sql`select kind::text as kind, status::text as status from control_requests`);
  expect(open).toEqual([{ kind: "translate_job", status: "pending" }]);
});

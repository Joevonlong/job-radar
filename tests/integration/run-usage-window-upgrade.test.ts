import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, inject, it } from "vitest";

import { createConnection } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { schema } from "@/lib/db";

const url = new URL(inject("testDatabaseUrl"));
const name = `${url.pathname.slice(1)}_run_window`;
// Only create/drop a sibling of the disposable database supplied by the integration harness.
if (!/^jobradar_test_[a-z0-9_]+$/.test(name)) throw new Error("expected a disposable test database name");
url.pathname = "/postgres";
const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
url.pathname = `/${name}`;
const connection = createConnection(url.toString(), { max: 1 });
const db = connection.db;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-run-window-upgrade-"));
let created = false;

beforeAll(async () => {
  await admin.unsafe(`create database "${name}"`);
  created = true;
  fs.cpSync(path.resolve("drizzle"), directory, { recursive: true });
  const journalPath = path.join(directory, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 33);
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  await runMigrations({ url: url.toString(), migrationsFolder: directory });
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

it("preserves old run rows and accepts old-column inserts after adding usage and window columns", async () => {
  const columns = await db.execute<{ column_name: string }>(sql`
    select column_name from information_schema.columns where table_schema = 'public' and table_name = 'runs'
  `);
  const names = columns.map((column) => column.column_name);
  expect(names).toContain("interrupted");
  for (const column of ["usage_units", "window_hours", "window_extended"]) expect(names).not.toContain(column);
  await db.execute(sql`insert into channels (id, family, kind) values ('upgrade-fixture', 'manual', 'manual')`);
  await db.execute(sql`insert into cycles (kind, started_at, finished_at, status, summary_json)
    values ('manual', '2026-10-01T08:00:00Z', '2026-10-01T08:05:00Z', 'succeeded', '{"fixture":true}')`);

  // Explicitly name every pre-window column, including interrupted from the immediately preceding migration.
  const insertOldRows = () => db.execute(sql`
    insert into runs (cycle_id, channel_id, query_hash, started_at, finished_at, status, fetched, new_count, cost, error, error_code, interrupted)
    values
      (1, 'upgrade-fixture', 'complete-query', '2026-10-01T08:00:00Z', '2026-10-01T08:01:00Z', 'succeeded', 3, 2, 0.012345, null, null, false),
      (1, 'upgrade-fixture', 'partial-query', '2026-10-01T08:02:00Z', '2026-10-01T08:03:00Z', 'partial', 2, 1, 0.004500, 'later page failed', 'network', true)
  `);
  await insertOldRows();
  const oldRows = () => db.execute(sql`
    select id, cycle_id, channel_id, query_hash, started_at, finished_at, status, fetched, new_count, cost, error, error_code, interrupted
    from runs order by id
  `);
  const before = [...await oldRows()];
  expect(before).toHaveLength(2);
  await runMigrations({ url: url.toString() });
  expect([...await oldRows()]).toEqual(before);
  expect(await db.select({ usageUnits: schema.runs.usageUnits, windowHours: schema.runs.windowHours, windowExtended: schema.runs.windowExtended })
    .from(schema.runs).orderBy(schema.runs.id)).toEqual([
    { usageUnits: 0, windowHours: null, windowExtended: false },
    { usageUnits: 0, windowHours: null, windowExtended: false },
  ]);

  await insertOldRows();
  const after = await db.select().from(schema.runs).orderBy(schema.runs.id);
  expect(after).toHaveLength(4);
  for (let index = 0; index < 2; index += 1) expect(after[index + 2]).toEqual({ ...after[index], id: index + 3 });
  expect(after.map((row) => row.id)).toEqual([1, 2, 3, 4]);
  expect(after.every((row) => row.usageUnits === 0 && row.windowHours === null && row.windowExtended === false)).toBe(true);
});

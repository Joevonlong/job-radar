import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, inject, it } from "vitest";

import { createConnection } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";

const url = new URL(inject("testDatabaseUrl"));
const name = `${url.pathname.slice(1)}_undo_upgrade`;
if (!/^jobradar_test_[a-z0-9_]+$/.test(name)) throw new Error("expected a disposable test database name");
url.pathname = "/postgres";
const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
url.pathname = `/${name}`;
const connection = createConnection(url.toString(), { max: 1 });
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-undo-upgrade-"));
let created = false;

beforeAll(async () => {
  await admin.unsafe(`create database "${name}"`);
  created = true;
  fs.cpSync(path.resolve("drizzle"), directory, { recursive: true });
  const journalPath = path.join(directory, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: { idx: number; when: number; tag: string }[] };
  const latest = journal.entries.find((entry) => entry.tag === "0062_agent_undo")!;
  expect(latest.when).toBeGreaterThan(Math.max(...journal.entries.filter((entry) => entry.idx < latest.idx).map((entry) => entry.when)));
  journal.entries = journal.entries.filter((entry) => entry.idx <= 61);
  expect(journal.entries.at(-1)?.tag).toBe("0061_agent_tokens");
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  await runMigrations({ url: url.toString(), migrationsFolder: directory, currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
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

it("upgrades from the token schema, preserves tokens and audit rows, and safely runs the SQL again", async () => {
  const db = connection.db;
  expect(await db.execute(sql`select to_regclass('public.agent_undo') as name`)).toEqual([{ name: null }]);
  const [token] = await db.execute<{ id: number }>(sql`insert into agent_tokens (name, token_hash, token_prefix) values ('existing token', 'existing-hash', 'jrt_existing') returning id`);
  const [audit] = await db.execute<{ id: number }>(sql`insert into agent_calls (capability, outcome, returned_count, duration_ms, token_id) values ('existing_call', 'ok', 0, 0, ${token.id}) returning id::int`);
  await runMigrations({ url: url.toString(), migrationsFolder: path.resolve("drizzle"), currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
  expect(await db.execute(sql`select to_regclass('public.agent_undo') as name`)).toEqual([{ name: "agent_undo" }]);
  const migration = fs.readFileSync(path.resolve("drizzle/0062_agent_undo.sql"), "utf8");
  for (let run = 0; run < 2; run++) for (const statement of migration.split("--> statement-breakpoint")) await db.execute(sql.raw(statement));
  expect(await db.execute(sql`select capability, token_id from agent_calls where id = ${audit.id}`)).toEqual([{ capability: "existing_call", token_id: token.id }]);
  expect(await db.execute(sql`select name from agent_tokens where id = ${token.id}`)).toEqual([{ name: "existing token" }]);
  const columns = await db.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'agent_undo'`);
  expect(columns.map((row) => row.column_name).sort()).toEqual(["audit_id", "data_area", "kind", "target_type", "target_id", "before_value", "after_fingerprint", "undone_at", "caller"].sort());
  const indexes = await db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where schemaname = 'public' and tablename = 'agent_undo'`);
  expect(indexes.map((row) => row.indexname).sort()).toEqual(["agent_undo_pkey", "agent_undo_target_idx"]);
  const constraints = await db.execute(sql`select confdeltype from pg_constraint where conrelid = 'agent_undo'::regclass and contype = 'f'`);
  expect(constraints).toEqual([{ confdeltype: "c" }]);
  await db.execute(sql`insert into agent_undo (audit_id, data_area, kind, target_type, target_id, before_value, after_fingerprint, caller) values (${audit.id}, 'tracking', 'application_status', 'job', 7, '"new"'::jsonb, 'fingerprint', 'stdio')`);
  await expect(db.execute(sql`insert into agent_undo (audit_id, data_area, kind, target_type, target_id, before_value, after_fingerprint, caller) values (99999, 'tracking', 'application_status', 'job', 7, '"new"'::jsonb, 'fingerprint', 'stdio')`)).rejects.toThrow();
  await db.execute(sql`delete from agent_calls where id = ${audit.id}`);
  expect(await db.execute(sql`select * from agent_undo`)).toHaveLength(0);
});

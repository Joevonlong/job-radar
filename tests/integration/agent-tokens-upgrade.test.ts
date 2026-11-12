import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, inject, it } from "vitest";

import { createConnection } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";

const url = new URL(inject("testDatabaseUrl"));
const name = `${url.pathname.slice(1)}_tokens_upgrade`;
// Only create/drop a sibling of the disposable database supplied by the integration harness.
if (!/^jobradar_test_[a-z0-9_]+$/.test(name)) throw new Error("expected a disposable test database name");
url.pathname = "/postgres";
const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
url.pathname = `/${name}`;
const connection = createConnection(url.toString(), { max: 1 });
const db = connection.db;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-tokens-upgrade-"));
const backfill = { lockTimeoutMs: 3000, statementTimeoutMs: 60000 };
const MIGRATION = "agent_tokens";
let created = false;

interface Journal { entries: { idx: number; when: number; tag: string }[] }

function journal(folder: string): Journal {
  return JSON.parse(fs.readFileSync(path.join(folder, "meta/_journal.json"), "utf8")) as Journal;
}

async function tokenObjects(): Promise<{ table: string[]; constraint: string[] }> {
  const table = await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' and table_name = 'agent_tokens'`);
  const constraint = await db.execute<{ conname: string }>(sql`select conname from pg_constraint where conname = 'agent_calls_token_id_agent_tokens_id_fk'`);
  return { table: table.map((row) => row.table_name), constraint: constraint.map((row) => row.conname) };
}

beforeAll(async () => {
  await admin.unsafe(`create database "${name}"`);
  created = true;
  // a deployed database: every migration on main before the token migration
  fs.cpSync(path.resolve("drizzle"), directory, { recursive: true });
  const journalPath = path.join(directory, "meta/_journal.json");
  const full = journal(directory);
  const at = full.entries.findIndex((entry) => entry.tag.endsWith(`_${MIGRATION}`));
  if (at < 1) throw new Error("the agent tokens migration is missing");
  fs.writeFileSync(journalPath, JSON.stringify({ ...full, entries: full.entries.slice(0, at) }));
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

// drizzle applies a migration only when its journal time is newer than the newest one already applied; the tag is not compared.
it("is newer than every entry before it, so a database that has every earlier migration still applies it", () => {
  const { entries } = journal(path.resolve("drizzle"));
  const at = entries.findIndex((entry) => entry.tag.endsWith(`_${MIGRATION}`));
  const own = entries[at];
  expect(own).toBeDefined();
  expect(entries.slice(0, at).every((entry) => entry.when < (own?.when ?? 0))).toBe(true);
  expect(entries.filter((entry) => entry.when === own?.when)).toHaveLength(1);
  expect(entries.map((entry) => entry.idx)).toEqual(entries.map((_, index) => index));
});

it("adds the table and the foreign key to a database that has all earlier migrations, keeps its audit rows, and runs again as a no-op", async () => {
  expect(await tokenObjects()).toEqual({ table: [], constraint: [] });
  await db.execute(sql`insert into agent_calls (caller, transport, capability, outcome, returned_count, duration_ms) values ('stdio', 'stdio', 'search_jobs', 'ok', 1, 5)`);

  await runMigrations({ currentScoresBackfill: backfill, url: url.toString() });
  await runMigrations({ currentScoresBackfill: backfill, url: url.toString() });

  expect(await tokenObjects()).toEqual({ table: ["agent_tokens"], constraint: ["agent_calls_token_id_agent_tokens_id_fk"] });
  const rows = await db.execute<{ token_id: number | null }>(sql`select token_id from agent_calls`);
  expect(rows).toEqual([{ token_id: null }]);
});

// The migrator skips SQL it has applied, so running it twice proves nothing about the file: replay the statements themselves.
it("can be replayed statement by statement on a database that already has it", async () => {
  const file = fs.readFileSync(path.resolve("drizzle", `${journal(path.resolve("drizzle")).entries.find((entry) => entry.tag.endsWith(`_${MIGRATION}`))?.tag}.sql`), "utf8");
  for (const statement of file.split("--> statement-breakpoint").map((part) => part.trim()).filter((part) => part !== "")) await db.execute(sql.raw(statement));
  expect(await tokenObjects()).toEqual({ table: ["agent_tokens"], constraint: ["agent_calls_token_id_agent_tokens_id_fk"] });
});

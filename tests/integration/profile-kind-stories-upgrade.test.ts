import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, inject, it } from "vitest";

import { createConnection } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { listProfileSnapshots, saveProfileSnapshot } from "@/lib/db";

const url = new URL(inject("testDatabaseUrl"));
const name = `${url.pathname.slice(1)}_stories_kind`;
// Only create/drop a sibling of the disposable database supplied by the integration harness.
if (!/^jobradar_test_[a-z0-9_]+$/.test(name)) throw new Error("expected a disposable test database name");
url.pathname = "/postgres";
const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
url.pathname = `/${name}`;
const connection = createConnection(url.toString(), { max: 1 });
const db = connection.db;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-stories-kind-upgrade-"));
let created = false;
const backfill = { lockTimeoutMs: 3000, statementTimeoutMs: 60000 };

/** The profile_kind values the database knows, in order. */
async function kinds(): Promise<string[]> {
  const rows = await db.execute<{ value: string }>(sql`select unnest(enum_range(null::profile_kind))::text as value`);
  return rows.map((row) => row.value);
}

beforeAll(async () => {
  await admin.unsafe(`create database "${name}"`);
  created = true;
  // every migration before the one that adds the stories kind
  fs.cpSync(path.resolve("drizzle"), directory, { recursive: true });
  const journalPath = path.join(directory, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  const at = journal.entries.findIndex((entry) => entry.tag.endsWith("_profile_kind_stories"));
  if (at < 1) throw new Error("the stories kind migration is missing");
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

it("adds the stories kind and leaves the existing snapshots as they were", async () => {
  expect(await kinds()).toEqual(["me", "preferences", "interests"]);
  const me = await saveProfileSnapshot(db, "me", "summary: before the upgrade\n");
  const preferences = await saveProfileSnapshot(db, "preferences", "target_titles: [Engineer]\n");

  await runMigrations({ currentScoresBackfill: backfill, url: url.toString() });

  expect(await kinds()).toEqual(["me", "preferences", "interests", "stories"]);
  expect(await listProfileSnapshots(db, "me", 5)).toEqual([me]);
  expect(await listProfileSnapshots(db, "preferences", 5)).toEqual([preferences]);
  const stories = await saveProfileSnapshot(db, "stories", "stories: []\n");
  expect(await listProfileSnapshots(db, "stories", 5)).toEqual([stories]);
});

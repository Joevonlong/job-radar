import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, inject, it } from "vitest";

import { expireScrubbedRequests } from "@/lib/control/expire";
import { aiWorkerRequestKinds } from "@/lib/control/kinds";
import { createConnection } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { claimNextControlRequest, findLatestStoryExtractRequest, finishControlRequest, requeueInterruptedControlRequests } from "@/lib/db/repos/control-requests";

const url = new URL(inject("testDatabaseUrl"));
const name = `${url.pathname.slice(1)}_story_upgrade`;
// Only create/drop a sibling of the disposable database supplied by the integration harness.
if (!/^jobradar_test_[a-z0-9_]+$/.test(name)) throw new Error("expected a disposable test database name");
url.pathname = "/postgres";
const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
url.pathname = `/${name}`;
const connection = createConnection(url.toString(), { max: 1 });
const db = connection.db;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-story-upgrade-"));
let created = false;
const backfill = { lockTimeoutMs: 3000, statementTimeoutMs: 60000 };

async function requestKinds(): Promise<string[]> {
  const rows = await db.execute<{ value: string }>(sql`select unnest(enum_range(null::control_request_kind))::text as value`);
  return rows.map((row) => row.value);
}

async function draftTableExists(): Promise<boolean> {
  const rows = await db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' and table_name = 'profile_story_drafts'`);
  return rows.length === 1;
}

beforeAll(async () => {
  await admin.unsafe(`create database "${name}"`);
  created = true;
  // every migration before the one that adds story extraction
  fs.cpSync(path.resolve("drizzle"), directory, { recursive: true });
  const journalPath = path.join(directory, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  const at = journal.entries.findIndex((entry) => entry.tag.endsWith("_story_extract_drafts"));
  if (at < 1) throw new Error("the story extraction migration is missing");
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

// A worker of the new release can start while the web has not migrated yet: its startup and poll queries pass the new kind.
it("runs the ai-worker's and the page's queries before the migration adds story_extract to the enum", async () => {
  expect(await requestKinds()).not.toContain("story_extract");
  const kinds = aiWorkerRequestKinds("host");
  expect(kinds).toContain("story_extract");
  await db.execute(sql`insert into control_requests (kind, payload, status, started_at) values ('translate_job', '{"jobId": 2}'::jsonb, 'running', now())`);

  expect(await requeueInterruptedControlRequests(db, { reason: "ai-worker restarted", maxRequeues: 3, kinds })).toEqual({ requeued: 1, failed: 0 });
  expect(await expireScrubbedRequests(db, { settings: { timeout_seconds: 30, expiry_grace_seconds: 10, queue_timeout_seconds: 60 } })).toBe(0);
  expect(await findLatestStoryExtractRequest(db)).toBeNull();
  const claimed = (await claimNextControlRequest(db, kinds, { lane: "interactive" })) ?? (await claimNextControlRequest(db, kinds, { lane: "batch" }));
  expect(claimed?.kind).toBe("translate_job");
  expect((await finishControlRequest(db, claimed?.id ?? 0, { status: "done", result: {} }))?.status).toBe("done");

  await db.execute(sql`delete from control_requests`);
});

it("adds the table and the kind next to open requests of other kinds, and runs again as a no-op", async () => {
  expect(await draftTableExists()).toBe(false);
  await db.execute(sql`insert into control_requests (kind, payload) values ('translate_job', '{"jobId": 1}'::jsonb)`);

  await runMigrations({ currentScoresBackfill: backfill, url: url.toString() });
  await runMigrations({ currentScoresBackfill: backfill, url: url.toString() });

  expect(await requestKinds()).toContain("story_extract");
  expect(await draftTableExists()).toBe(true);
  const open = await db.execute<{ kind: string; status: string }>(sql`select kind::text as kind, status::text as status from control_requests`);
  expect(open).toEqual([{ kind: "translate_job", status: "pending" }]);
});

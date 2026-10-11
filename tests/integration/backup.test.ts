import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { closeDb, countTableRows, createConnection, enqueueAlert, getDb, listPendingAlerts } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { BackupError, listBackups, runBackup, type RunBackupOptions } from "@/lib/ops/backup";
import { createBackupScheduler } from "@/lib/ops/backup-job";
import { createLogger } from "@/lib/channels/logger";

import { resolvePgTools, type PgTools } from "./pg-tools";

const url = inject("testDatabaseUrl");
// pg_dump through `docker exec` can be slow when other stacks share the machine.
const SLOW_TEST_MS = 90_000;

let tools: PgTools | null = null;
let dir = "";
const restoredName = `${new URL(url).pathname.slice(1)}_restored`;

function adminUrl(): string {
  const admin = new URL(url);
  admin.pathname = "/postgres";
  return admin.toString();
}

function urlOf(database: string): string {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next.toString();
}

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
  tools = await resolvePgTools(url);
  // CI provides the client tools and sets REQUIRE_PG_TOOLS, so the real dump/restore tests cannot pass by skipping.
  if (tools === null && process.env.REQUIRE_PG_TOOLS) throw new Error("REQUIRE_PG_TOOLS is set but no usable pg_dump / pg_restore was found");
  if (tools === null) console.warn("[backup.test] no usable pg_dump (host binary >= server, or docker exec into job-radar-db-1): tests are skipped");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-backup-it-"));
});

// Data with every flavour a dump has to carry: bulk rows, unicode, jsonb, enums, timestamps, foreign keys.
// Seeded before every test (the database is emptied before each one), so no test depends on another.
beforeEach(async () => {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`truncate table runner_heartbeats, notifications, runs, cycles restart identity cascade`;
    await sql`insert into runner_heartbeats (process, at) select 'runner', now() - (g || ' seconds')::interval from generate_series(1, 500) g`;
    await sql`insert into cycles (kind, status) values ('weekday_morning', 'succeeded'), ('manual', 'partial')`;
    await sql`insert into notifications (kind, payload_json) values ('digest', ${sql.json({ title: "Müller & Söhne – Entwickler (m/w/d) 🚀", nested: { a: [1, 2, 3] } })})`;
  } finally {
    await sql.end({ timeout: 2 });
  }
});

afterAll(async () => {
  await closeDb();
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists "${restoredName}" with (force)`);
  } finally {
    await admin.end({ timeout: 2 });
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function options(overrides: Partial<RunBackupOptions> = {}): RunBackupOptions {
  if (tools === null) throw new Error("pg tools unavailable");
  return {
    directory: path.join(dir, "backups"),
    databaseUrl: tools.urlFor(url),
    timeZone: "Europe/Berlin",
    policy: { keepDaily: 14, keepWeekly: 8 },
    timeoutMs: 60_000,
    pgDump: tools.dump,
    pgRestore: tools.restore,
    ...overrides,
  };
}

describe("scheduled backup and restore (real pg_dump)", () => {
  it("dumps the database, and restoring into a temporary database gives the same tables and row counts", async (ctx) => {
    if (tools === null) return ctx.skip();
    const result = await runBackup(options({ now: () => new Date("2026-10-07T01:30:00Z") }));
    expect(result.file).toBe("jobradar-20261007-033000.dump");
    expect(result.bytes).toBeGreaterThan(100);

    const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`create database "${restoredName}"`);
    } finally {
      await admin.end({ timeout: 2 });
    }

    const restoreUrl = new URL(tools.urlFor(urlOf(restoredName)));
    const restoreArgs = [
      "--no-owner",
      "--no-acl",
      "--exit-on-error",
      "--host",
      restoreUrl.hostname,
      "--port",
      restoreUrl.port,
      "--username",
      decodeURIComponent(restoreUrl.username),
      "--no-password",
      "--dbname",
      restoredName,
    ];
    const [command, ...leading] = tools.restore;
    const restored = spawnSync(command as string, [...leading, ...restoreArgs], {
      input: fs.readFileSync(result.path),
      env: { ...process.env, PGPASSWORD: decodeURIComponent(restoreUrl.password) },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(restored.status, restored.stderr).toBe(0);

    const target = createConnection(urlOf(restoredName), { max: 1 });
    try {
      const source = await countTableRows(getDb());
      const copy = await countTableRows(target.db);
      expect(copy).toEqual(source);
      expect(source.length).toBeGreaterThanOrEqual(19);
      expect(source.find((t) => t.table === "public.runner_heartbeats")?.rows).toBe(500);
      expect(source.find((t) => t.table === "public.cycles")?.rows).toBe(2);

      const [row] = await target.sql<{ title: string }[]>`select payload_json->>'title' as title from notifications where kind = 'digest'`;
      expect(row?.title).toBe("Müller & Söhne – Entwickler (m/w/d) 🚀");
    } finally {
      await target.sql.end({ timeout: 2 });
    }
  }, SLOW_TEST_MS);

  it("keeps 14 daily and the weekly backups when it runs on 60 consecutive fake days", async (ctx) => {
    if (tools === null) return ctx.skip();
    const directory = path.join(dir, "retention");
    const start = Date.UTC(2026, 7, 1, 1, 30); // 2026-08-01 03:30 Berlin
    // Real dumps are slow-ish: 60 runs of a tiny database is still a few seconds.
    for (let day = 0; day < 60; day++) {
      await runBackup(options({ directory, now: () => new Date(start + day * 86_400_000), policy: { keepDaily: 14, keepWeekly: 8 } }));
    }
    const names = (await listBackups(directory)).map((f) => f.name);
    // last day: 2026-09-29 (a Tuesday, ISO week 40); the 14 days cover weeks 40, 39 and 38, so 8 weeks leave 5 older weekly ones
    expect(names).toHaveLength(14 + 5);
    expect(names[0]).toBe("jobradar-20260929-033000.dump");
    expect(fs.readdirSync(directory).filter((n) => n.endsWith(".partial"))).toEqual([]);
  }, 180_000);

  it("a failing backup throws a BackupError, leaves no file, and queues an alert", async (ctx) => {
    if (tools === null) return ctx.skip();
    const directory = path.join(dir, "failing");
    const broken = new URL(tools.urlFor(url));
    broken.pathname = "/no_such_database"; // fails with any auth setup (the docker route connects over a trusted loopback)
    const run = () => runBackup(options({ directory, databaseUrl: broken.toString() }));

    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackupError);
    expect((error as BackupError).code).toBe("pg_dump_failed");
    expect((error as BackupError).message).toContain("no_such_database");
    expect((error as BackupError).message).not.toContain(decodeURIComponent(broken.password));
    expect(fs.existsSync(directory) ? fs.readdirSync(directory) : []).toEqual([]);

    const scheduler = createBackupScheduler({
      config: { enabled: false, cron: "30 3 * * *", keep_daily: 14, keep_weekly: 8, timeout_minutes: 30, config_archive: true, pre_migrate: true, keep_system: 5, keep_old_databases: 1 },
      timeZone: "Europe/Berlin",
      logger: createLogger({ sink: () => {} }),
      run,
      onFailure: async (failure) => {
        await enqueueAlert(getDb(), { kind: "alert.backup_failed", payload: { code: failure.code, message: failure.message } });
      },
    });
    expect(await scheduler.runNow("scheduled")).toBeNull();
    const pending = await listPendingAlerts(getDb(), "alert.backup_failed");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.sentAt).toBeNull();
    expect(JSON.stringify(pending[0]?.payloadJson)).toContain("pg_dump_failed");
  }, SLOW_TEST_MS);
});

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { closeDb, countTableRows, createConnection, enqueueAlert, getDb, listPendingAlerts } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { checkAgentChangeIdentity, readAgentChangeLogIdentity } from "@/lib/db/repos/agent-changes";
import { agentChanges } from "@/lib/db/schema";
import { BackupError, listBackups, runBackup, type RunBackupOptions } from "@/lib/ops/backup";
import { createBackupScheduler } from "@/lib/ops/backup-job";
import { createLogger } from "@/lib/channels/logger";
import { createDocument, listDocumentVersions } from "@/lib/career/store/documents";
import {
  careerDocumentHistoryDir, careerDocumentPath, careerImagePath, careerPreferencesPath,
} from "@/lib/career/store/paths";
import { saveImage } from "@/lib/career/store/images";
import { loadPreferences, savePreferences } from "@/lib/career/store/preferences";

import { resolvePgTools, type PgTools } from "./pg-tools";
import { tempCareer } from "../career/fixtures";
import { document } from "../career/document-fixtures";
import { imagePng, imageJpeg } from "../career/engine/helpers/images";

const url = inject("testDatabaseUrl");
const mainName = new URL(url).pathname.slice(1);
const backfill = { lockTimeoutMs: 3000, statementTimeoutMs: 60_000 };
// pg_dump through `docker exec` can be slow when other stacks share the machine.
const SLOW_TEST_MS = 90_000;

let tools: PgTools | null = null;
let dir = "";
const restoredName = `${mainName}_restored`;
const oldName = `${mainName}_old_schema`;
const oldRestoredName = `${mainName}_restored_old`;

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
  await runMigrations({ currentScoresBackfill: backfill });
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
    for (const name of [restoredName, oldName, oldRestoredName]) {
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    }
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

function shellCommand(parts: string[]): string {
  return parts.map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ");
}

/** Run the restore script with the Compose transport replaced by the test server's real PostgreSQL clients. */
function restoreBackup(tools: PgTools, dump: string, target: string) {
  const checkout = path.join(dir, "restore-project");
  const bin = path.join(checkout, "bin");
  fs.mkdirSync(path.join(checkout, "scripts/ops/lib"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  for (const file of ["restore.sh", "lib/config.sh", "lib/existing-install.sh", "lib/timezone.sh", "lib/ai-worker.sh"]) {
    fs.copyFileSync(path.join("scripts/ops", file), path.join(checkout, "scripts/ops", file));
  }

  const restoreExecutable = tools.restore[0]!;
  const pgRestore = restoreExecutable.includes(path.sep)
    ? [path.resolve(restoreExecutable), ...tools.restore.slice(1)] : tools.restore;
  const psqlSibling = pgRestore[0]!.includes(path.sep) ? path.join(path.dirname(pgRestore[0]!), "psql") : null;
  const psql = tools.mode === "docker" ? [...pgRestore.slice(0, -1), "psql"]
    : [psqlSibling && fs.existsSync(psqlSibling) ? psqlSibling : "psql"];
  fs.writeFileSync(path.join(bin, "docker"), `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "compose ps --status running --services") echo db; exit 0 ;;
  "compose exec -T db "*) shift 4 ;;
  *) echo "unexpected compose command" >&2; exit 1 ;;
esac
export PATH="$RESTORE_TEST_PATH"
case "$1" in
  sh)
    case "$3" in
      *POSTGRES_USER*) printf %s "$RESTORE_TEST_USER" ;;
      *POSTGRES_DB*) printf %s "$RESTORE_TEST_DATABASE" ;;
      *) exit 1 ;;
    esac ;;
  psql) shift; exec ${shellCommand(psql)} -h "$RESTORE_TEST_HOST" -p "$RESTORE_TEST_PORT" "$@" ;;
  pg_restore) shift; exec ${shellCommand(pgRestore)} -h "$RESTORE_TEST_HOST" -p "$RESTORE_TEST_PORT" "$@" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });

  const address = new URL(tools.urlFor(url));
  const toolPath = process.env.PATH ?? "";
  return spawnSync("bash", [path.join(checkout, "scripts/ops/restore.sh"), dump, "--target", target], {
    cwd: checkout,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${toolPath}`,
      RESTORE_TEST_PATH: toolPath,
      RESTORE_TEST_HOST: address.hostname,
      RESTORE_TEST_PORT: address.port || "5432",
      RESTORE_TEST_USER: decodeURIComponent(address.username),
      RESTORE_TEST_DATABASE: mainName,
      PGPASSWORD: decodeURIComponent(address.password),
    },
  });
}

describe("scheduled backup and restore (real pg_dump)", () => {
  it("backs up and restores documents, their history, preferences, photo and signature", async (ctx) => {
    if (tools === null) return ctx.skip();
    const temp = tempCareer();
    try {
      const created = await createDocument(document());
      const versions = await listDocumentVersions(created.document.id);
      expect(versions).toHaveLength(1);
      const preferences = await savePreferences((await loadPreferences()).preferences, { baseHash: null });
      expect(preferences.ok).toBe(true);
      await saveImage("photo", imagePng());
      await saveImage("signature", imageJpeg());
      const files = [
        careerDocumentPath(created.document.id),
        path.join(careerDocumentHistoryDir(created.document.id), versions[0]!.id),
        careerPreferencesPath(), careerImagePath("photo", "png"), careerImagePath("signature", "jpg"),
      ].map((file) => ({ name: path.relative(temp.profileDir, file), bytes: fs.readFileSync(file) }));
      const result = await runBackup(options({
        directory: path.join(temp.root, "backups"),
        configArchive: { dirs: { config: temp.configDir, profile: temp.profileDir } },
      }));
      expect(result.configWarning).toBeNull();
      expect(result.configFile).not.toBeNull();
      expect((await listBackups(path.join(temp.root, "backups")))[0]?.hasConfig).toBe(true);
      const archive = path.join(temp.root, "backups", result.configFile!);
      const listed = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
      expect(listed.status, listed.stderr).toBe(0);
      const members = files.map(({ name }) => `data/profile/${name}`);
      expect(listed.stdout.split("\n")).toEqual(expect.arrayContaining(members));
      const target = path.join(temp.root, "restored");
      fs.mkdirSync(target);
      const restored = spawnSync("tar", ["-xzf", archive, "-C", target], { encoding: "utf8" });
      expect(restored.status, restored.stderr).toBe(0);
      for (const { name, bytes } of files) {
        const file = path.join(target, "data/profile", name);
        expect(fs.readFileSync(file), name).toEqual(bytes);
        expect(fs.statSync(file).mode & 0o777, name).toBe(0o600);
      }
    } finally {
      temp.cleanup();
    }
  }, SLOW_TEST_MS);

  it("restores the backed-up rows and resets the change log in a named target", async (ctx) => {
    if (tools === null) return ctx.skip();
    const original = await readAgentChangeLogIdentity(getDb());
    expect(original).not.toBeNull();
    await getDb().insert(agentChanges).values({ keyKind: "job", key: "backed-up-change", blocks: 1 });
    const result = await runBackup(options({ now: () => new Date("2026-10-07T01:30:00Z") }));
    expect(result.file).toBe("jobradar-20261007-033000.dump");
    expect(result.bytes).toBeGreaterThan(100);

    const restored = restoreBackup(tools, result.path, restoredName);
    expect(restored.status, restored.stderr + restored.stdout).toBe(0);

    const target = createConnection(urlOf(restoredName), { max: 1 });
    try {
      const source = await countTableRows(getDb());
      const copy = await countTableRows(target.db);
      expect(copy).toEqual(source.map((table) => table.table === "public.agent_changes" ? { ...table, rows: 0 } : table));
      expect(source.length).toBeGreaterThanOrEqual(19);
      expect(source.find((t) => t.table === "public.runner_heartbeats")?.rows).toBe(500);
      expect(source.find((t) => t.table === "public.cycles")?.rows).toBe(2);
      expect(source.find((t) => t.table === "public.agent_changes")?.rows).toBe(1);

      const checked = await checkAgentChangeIdentity(target.db);
      expect(checked.status).toBe("match");
      const identity = await readAgentChangeLogIdentity(target.db);
      expect(identity?.systemIdentifier).toBe(original?.systemIdentifier);
      expect(identity?.databaseOid).not.toBe(original?.databaseOid);
      expect(identity?.logId).not.toBe(original?.logId);
      expect(await readAgentChangeLogIdentity(getDb())).toEqual(original);

      const [row] = await target.sql<{ title: string }[]>`select payload_json->>'title' as title from notifications where kind = 'digest'`;
      expect(row?.title).toBe("Müller & Söhne – Entwickler (m/w/d) 🚀");
    } finally {
      await target.sql.end({ timeout: 2 });
    }
  }, SLOW_TEST_MS);

  it("restores a backup from before the change log migration", async (ctx) => {
    if (tools === null) return ctx.skip();
    const migrationsFolder = path.join(dir, "drizzle-before-sync");
    fs.cpSync("drizzle", migrationsFolder, { recursive: true });
    const journalFile = path.join(migrationsFolder, "meta/_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalFile, "utf8")) as { entries: { tag: string }[] };
    const migrationIndex = journal.entries.findIndex(({ tag }) => tag.endsWith("_agent_changes"));
    expect(migrationIndex).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, migrationIndex);
    fs.writeFileSync(journalFile, JSON.stringify(journal));

    const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`create database "${oldName}"`);
    } finally {
      await admin.end({ timeout: 2 });
    }
    const oldUrl = urlOf(oldName);
    await runMigrations({ url: oldUrl, migrationsFolder, currentScoresBackfill: backfill });
    const source = createConnection(oldUrl, { max: 1 });
    try {
      await source.sql`insert into runner_heartbeats (process, at) values ('old-backup', now())`;
    } finally {
      await source.sql.end({ timeout: 2 });
    }
    const backup = await runBackup(options({ directory: path.join(dir, "legacy-backup"), databaseUrl: tools.urlFor(oldUrl) }));

    const restored = restoreBackup(tools, backup.path, oldRestoredName);
    expect(restored.status, restored.stderr + restored.stdout).toBe(0);
    const target = createConnection(urlOf(oldRestoredName), { max: 1 });
    try {
      const [row] = await target.sql`
        select to_regclass('public.agent_change_log') is null as no_log,
          to_regprocedure('public.agent_changes_reset()') is null as no_reset,
          (select count(*)::int from runner_heartbeats where process = 'old-backup') as heartbeats`;
      expect(row).toMatchObject({ no_log: true, no_reset: true, heartbeats: 1 });
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

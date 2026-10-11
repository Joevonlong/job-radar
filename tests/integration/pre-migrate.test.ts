import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { createConnection, readAppliedMigrations } from "@/lib/db";
import { readJournal } from "@/lib/db/migration-journal";
import { runMigrations } from "@/lib/db/migrate";
import { migrateWithBackup, takePreMigrateBackup } from "@/lib/ops";

import { resolvePgTools, type PgTools } from "./pg-tools";

/**
 * The backup before pending migrations, with a real pg_dump: a scratch database is stopped one migration
 * short of the shipped journal, then migrateWithBackup rolls it forward. Skipped without pg tools (like backup.test.ts).
 */
const url = inject("testDatabaseUrl");
const SLOW_TEST_MS = 90_000;
const scratch = `${new URL(url).pathname.slice(1)}_premigrate`;
const fresh = `${scratch}_fresh`;

let tools: PgTools | null = null;
let dir = "";
let shipped = 0;

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
async function admin(statement: string): Promise<void> {
  const sql = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(statement);
  } finally {
    await sql.end({ timeout: 2 });
  }
}
async function appliedCount(database: string): Promise<number> {
  const connection = createConnection(urlOf(database), { max: 1 });
  try {
    return (await readAppliedMigrations(connection.db)).count;
  } finally {
    await connection.sql.end({ timeout: 2 });
  }
}

beforeAll(async () => {
  tools = await resolvePgTools(url);
  if (tools === null && process.env.REQUIRE_PG_TOOLS) throw new Error("REQUIRE_PG_TOOLS is set but no usable pg_dump / pg_restore was found");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-premigrate-it-"));
  const journal = await readJournal(path.resolve("drizzle"));
  shipped = journal?.count ?? 0;
  await admin(`drop database if exists "${scratch}" with (force)`);
  await admin(`drop database if exists "${fresh}" with (force)`);
});

afterAll(async () => {
  await admin(`drop database if exists "${scratch}" with (force)`);
  await admin(`drop database if exists "${fresh}" with (force)`);
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup(directory: string) {
  if (tools === null) throw new Error("pg tools unavailable");
  const config = path.join(dir, "app/data/config");
  const profile = path.join(dir, "app/data/profile");
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(config, "schedule.yaml"), "timezone: UTC\n");
  fs.writeFileSync(path.join(profile, "me.yaml"), "name: Test\n");
  return { directory, tools, config, profile };
}

describe("migrateWithBackup (real pg_dump)", () => {
  it("backs up a database that is one migration behind, then migrates it; the dump can be read by pg_restore", async (ctx) => {
    if (tools === null) return ctx.skip();
    expect(shipped).toBeGreaterThan(1);
    await admin(`create database "${scratch}"`);
    // a copy of the migrations folder whose journal stops one entry short
    const partial = path.join(dir, "drizzle-partial");
    fs.cpSync(path.resolve("drizzle"), partial, { recursive: true });
    const journalFile = path.join(partial, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalFile, "utf8")) as { entries: unknown[] };
    journal.entries = journal.entries.slice(0, -1);
    fs.writeFileSync(journalFile, JSON.stringify(journal));
    await runMigrations({ url: urlOf(scratch), migrationsFolder: partial });
    expect(await appliedCount(scratch)).toBe(shipped - 1);

    const backups = path.join(dir, "backups");
    const s = setup(backups);
    const logs: string[] = [];
    const result = await migrateWithBackup({
      config: { pre_migrate: true },
      readJournal: () => readJournal(path.resolve("drizzle")),
      readApplied: async () => ({ count: await appliedCount(scratch) }),
      runMigrations: () => runMigrations({ url: urlOf(scratch) }),
      runBackup: (label) =>
        takePreMigrateBackup(label, {
          directory: s.directory,
          databaseUrl: s.tools.urlFor(urlOf(scratch)),
          timeZone: "Europe/Berlin",
          timeoutMs: 60_000,
          pgDump: s.tools.dump,
          pgRestore: s.tools.restore,
          backup: { config_archive: true, keep_system: 5 },
          configDirs: { config: s.config, profile: s.profile },
        }),
      log: (message) => logs.push(message),
    });

    expect(result.backup).toMatch(new RegExp(`^jobradar-manual-\\d{8}-\\d{6}-premigrate-${shipped - 1}-${shipped}\\.dump$`));
    expect(await appliedCount(scratch)).toBe(shipped);
    expect(fs.readdirSync(backups).sort()).toEqual([result.backup, (result.backup ?? "").replace(/\.dump$/, ".config.tgz")].sort());

    const [command, ...leading] = s.tools.restore;
    const listed = spawnSync(command as string, [...leading, "--list"], { input: fs.readFileSync(path.join(backups, result.backup ?? "")), encoding: "utf8", timeout: 60_000 });
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toContain("__drizzle_migrations");

    // running again: already up to date, no second backup
    const again = await migrateWithBackup({
      config: { pre_migrate: true },
      readJournal: () => readJournal(path.resolve("drizzle")),
      readApplied: async () => ({ count: await appliedCount(scratch) }),
      runMigrations: () => runMigrations({ url: urlOf(scratch) }),
      runBackup: () => {
        throw new Error("no backup expected");
      },
    });
    expect(again.backup).toBeNull();
  }, SLOW_TEST_MS);

  it("takes no backup of a brand-new database", async (ctx) => {
    if (tools === null) return ctx.skip();
    await admin(`create database "${fresh}"`);
    const result = await migrateWithBackup({
      config: { pre_migrate: true },
      readJournal: () => readJournal(path.resolve("drizzle")),
      readApplied: async () => ({ count: await appliedCount(fresh) }),
      runMigrations: () => runMigrations({ url: urlOf(fresh) }),
      runBackup: () => {
        throw new Error("no backup expected");
      },
    });
    expect(result.backup).toBeNull();
    expect(await appliedCount(fresh)).toBe(shipped);
  }, SLOW_TEST_MS);
});

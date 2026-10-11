// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PassThrough, Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BackupError, applyRetention, applySystemRetention, listBackups, parsePgConnection, pgDumpArgs, runBackup, type RunBackupOptions } from "@/lib/ops/backup";

const PASSWORD = "p@ss:w/rd#1";
const URL = `postgres://jobradar:${encodeURIComponent(PASSWORD)}@db.internal:5432/jobradar`;

/** A stand-in for pg_dump: behaviour chosen by FAKE_PG_DUMP_MODE, arguments and environment recorded to FAKE_PG_DUMP_LOG. */
const FAKE_PG_DUMP = `
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_PG_DUMP_LOG, JSON.stringify({ argv: process.argv.slice(2), pgpassword: process.env.PGPASSWORD ?? null }));
const mode = process.env.FAKE_PG_DUMP_MODE;
if (mode === "ok") { process.stdout.write("PGDMP\\u0001custom-format-body"); process.exit(0); }
if (mode === "fail") { process.stderr.write("pg_dump: error: connection failed"); process.exit(2); }
if (mode === "fail-after-output") { process.stdout.write("PGDMP partial"); process.stderr.write("pg_dump: error: server closed the connection"); process.exit(1); }
if (mode === "garbage") { process.stdout.write("-- plain sql, not an archive"); process.exit(0); }
if (mode === "empty") { process.exit(0); }
if (mode === "hang") { process.stdout.write("PGDMP"); setInterval(() => {}, 1000); }
`;

/** A stand-in for `pg_restore --list`: reads stdin; FAKE_PG_RESTORE_MODE=fail rejects it. */
const FAKE_PG_RESTORE = `
let size = 0;
process.stdin.on("data", (c) => { size += c.length; });
process.stdin.on("end", () => {
  if (process.env.FAKE_PG_RESTORE_MODE === "fail") { process.stderr.write("pg_restore: error: unexpected end of file"); process.exit(1); }
  process.exit(0);
});
`;

let dir: string;
let backups: string;
let script: string;
let restoreScript: string;
let logFile: string;

const baseOptions = (overrides: Partial<RunBackupOptions> = {}): RunBackupOptions => ({
  directory: backups,
  databaseUrl: URL,
  timeZone: "Europe/Berlin",
  policy: { keepDaily: 14, keepWeekly: 8 },
  timeoutMs: 10_000,
  pgDump: [process.execPath, script],
  pgRestore: [process.execPath, restoreScript],
  now: () => new Date("2026-10-07T01:30:00Z"),
  ...overrides,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-backup-"));
  backups = path.join(dir, "backups");
  script = path.join(dir, "fake-pg-dump.cjs");
  logFile = path.join(dir, "fake.log");
  fs.writeFileSync(script, FAKE_PG_DUMP);
  restoreScript = path.join(dir, "fake-pg-restore.cjs");
  fs.writeFileSync(restoreScript, FAKE_PG_RESTORE);
  process.env.FAKE_PG_DUMP_LOG = logFile;
});

afterEach(() => {
  delete process.env.FAKE_PG_DUMP_MODE;
  delete process.env.FAKE_PG_RESTORE_MODE;
  delete process.env.FAKE_PG_DUMP_LOG;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("parsePgConnection / pgDumpArgs", () => {
  it("splits the URL and decodes the password", () => {
    expect(parsePgConnection(URL)).toEqual({ host: "db.internal", port: "5432", user: "jobradar", database: "jobradar", password: PASSWORD });
    expect(parsePgConnection("postgresql://u@h/d")).toMatchObject({ port: "5432", password: null });
  });

  it("rejects what is not a postgres URL with a message that names no value", () => {
    for (const bad of ["", "not a url", "mysql://u:secret@h/d", "postgres://u:secret@h/"]) {
      expect(() => parsePgConnection(bad)).toThrow(BackupError);
      try {
        parsePgConnection(bad);
      } catch (error) {
        expect((error as Error).message).not.toContain("secret");
      }
    }
  });

  it("builds custom-format arguments without the password", () => {
    const args = pgDumpArgs(parsePgConnection(URL));
    expect(args).toContain("--format=custom");
    expect(args.join(" ")).not.toContain(PASSWORD);
    expect(args.slice(args.indexOf("--dbname"))).toEqual(["--dbname", "jobradar"]);
  });
});

describe("runBackup", () => {
  it("writes a dated custom-format file, names it in the schedule's time zone, and passes the password only via the environment", async () => {
    process.env.FAKE_PG_DUMP_MODE = "ok";
    const result = await runBackup(baseOptions());
    expect(result.file).toBe("jobradar-20261007-033000.dump");
    expect(result.bytes).toBeGreaterThan(5);
    expect(fs.readFileSync(path.join(backups, result.file), "latin1").startsWith("PGDMP")).toBe(true);
    expect(fs.readdirSync(backups)).toEqual([result.file]); // no .partial left behind

    const seen = JSON.parse(fs.readFileSync(logFile, "utf8")) as { argv: string[]; pgpassword: string | null };
    expect(seen.pgpassword).toBe(PASSWORD);
    expect(seen.argv.join(" ")).not.toContain(PASSWORD);
    expect(seen.argv).toEqual(expect.arrayContaining(["--host", "db.internal", "--username", "jobradar", "--dbname", "jobradar"]));
  });

  it("applies the retention policy with a fake clock: one backup per day for 40 days leaves 14 dailies and the older weekly ones", async () => {
    process.env.FAKE_PG_DUMP_MODE = "ok";
    const start = Date.UTC(2026, 8, 1, 1, 30); // 2026-09-01 03:30 Berlin
    for (let day = 0; day < 40; day++) {
      await runBackup(baseOptions({ now: () => new Date(start + day * 86_400_000), policy: { keepDaily: 14, keepWeekly: 4 } }));
    }
    const names = (await listBackups(backups)).map((f) => f.name);
    // 2026-10-10 is the last day: the 14 newest days are 09-27..10-10, and the weeks before are W38, W37, W36...
    expect(names.slice(0, 14)).toEqual(
      Array.from({ length: 14 }, (_, i) => {
        const d = new Date(start + (39 - i) * 86_400_000);
        const pad = (n: number) => String(n).padStart(2, "0");
        return `jobradar-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-033000.dump`;
      }),
    );
    expect(names.length).toBeLessThan(14 + 4);
    expect(names.length).toBeGreaterThanOrEqual(14 + 1);
  });

  it("reports what retention removed and leaves manual and unrelated files alone", async () => {
    process.env.FAKE_PG_DUMP_MODE = "ok";
    fs.mkdirSync(backups, { recursive: true });
    fs.writeFileSync(path.join(backups, "jobradar-20260101-033000.dump"), "PGDMP old");
    fs.writeFileSync(path.join(backups, "jobradar-manual-20250101-000000.dump"), "PGDMP manual");
    fs.writeFileSync(path.join(backups, "notes.txt"), "keep me");
    const result = await runBackup(baseOptions({ policy: { keepDaily: 1, keepWeekly: 0 } }));
    expect(result.removed).toEqual(["jobradar-20260101-033000.dump"]);
    expect(fs.readdirSync(backups).sort()).toEqual(["jobradar-20261007-033000.dump", "jobradar-manual-20250101-000000.dump", "notes.txt"]);
  });

  it("fails with pg_dump's message, keeps older backups, and leaves no partial file", async () => {
    process.env.FAKE_PG_DUMP_MODE = "ok";
    await runBackup(baseOptions());
    process.env.FAKE_PG_DUMP_MODE = "fail";
    const error = await runBackup(baseOptions({ now: () => new Date("2026-10-08T01:30:00Z") })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackupError);
    expect((error as BackupError).code).toBe("pg_dump_failed");
    expect((error as BackupError).message).toContain("connection failed");
    expect((error as BackupError).message).not.toContain(PASSWORD);
    expect(fs.readdirSync(backups)).toEqual(["jobradar-20261007-033000.dump"]);
  });

  it("does not keep the output of a pg_dump that exited non-zero, even when it wrote a valid header", async () => {
    process.env.FAKE_PG_DUMP_MODE = "fail-after-output";
    await expect(runBackup(baseOptions())).rejects.toMatchObject({ code: "pg_dump_failed" });
    expect(fs.readdirSync(backups)).toEqual([]);
  });

  it("rejects output that is empty or not a custom-format archive", async () => {
    process.env.FAKE_PG_DUMP_MODE = "empty";
    await expect(runBackup(baseOptions())).rejects.toMatchObject({ code: "invalid_output" });
    process.env.FAKE_PG_DUMP_MODE = "garbage";
    await expect(runBackup(baseOptions())).rejects.toMatchObject({ code: "invalid_output" });
    expect(fs.readdirSync(backups)).toEqual([]);
  });

  it("creates the backup with owner-only permissions", async () => {
    process.env.FAKE_PG_DUMP_MODE = "ok";
    const result = await runBackup(baseOptions());
    expect(fs.statSync(result.path).mode & 0o777).toBe(0o600);
  });

  it("fails with io, removes the temp file and skips retention when the destination write fails", async () => {
    process.env.FAKE_PG_DUMP_MODE = "ok";
    fs.mkdirSync(backups, { recursive: true });
    fs.writeFileSync(path.join(backups, "jobradar-20260101-033000.dump"), "PGDMP old");
    const failing = (file: string): Writable => {
      fs.writeFileSync(file, "PGDMP");
      return new Writable({ write: (_chunk, _enc, cb) => cb(Object.assign(new Error("disk full"), { code: "ENOSPC" })) });
    };
    const error = await runBackup(baseOptions({ createDestination: failing, policy: { keepDaily: 1, keepWeekly: 0 } })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackupError);
    expect((error as BackupError).code).toBe("io");
    expect((error as BackupError).message).toContain("ENOSPC");
    // the old backup is untouched (retention did not run) and no partial file is left
    expect(fs.readdirSync(backups)).toEqual(["jobradar-20260101-033000.dump"]);
  });

  it("does not hang when the destination fails while pg_dump is still producing output", async () => {
    process.env.FAKE_PG_DUMP_MODE = "hang";
    const sink = (): Writable => new PassThrough().on("data", () => undefined).once("data", function (this: PassThrough) { this.destroy(Object.assign(new Error("io"), { code: "EIO" })); });
    await expect(runBackup(baseOptions({ createDestination: sink }))).rejects.toMatchObject({ code: "io" });
    expect(fs.readdirSync(backups)).toEqual([]);
  });

  it("rejects an archive that pg_restore --list cannot read, keeping older backups and running no retention", async () => {
    process.env.FAKE_PG_DUMP_MODE = "ok";
    await runBackup(baseOptions());
    process.env.FAKE_PG_RESTORE_MODE = "fail";
    const error = await runBackup(baseOptions({ now: () => new Date("2026-10-08T01:30:00Z"), policy: { keepDaily: 1, keepWeekly: 0 } })).catch((e: unknown) => e);
    expect((error as BackupError).code).toBe("invalid_output");
    expect((error as BackupError).message).toContain("unexpected end of file");
    expect(fs.readdirSync(backups)).toEqual(["jobradar-20261007-033000.dump"]);
  });

  it("reports a missing pg_restore binary as start_failed and keeps nothing", async () => {
    process.env.FAKE_PG_DUMP_MODE = "ok";
    await expect(runBackup(baseOptions({ pgRestore: [path.join(dir, "no-such-pg_restore")] }))).rejects.toMatchObject({ code: "start_failed" });
    expect(fs.readdirSync(backups)).toEqual([]);
  });

  it("kills a pg_dump that exceeds the timeout", async () => {
    process.env.FAKE_PG_DUMP_MODE = "hang";
    await expect(runBackup(baseOptions({ timeoutMs: 300 }))).rejects.toMatchObject({ code: "timeout" });
    expect(fs.readdirSync(backups)).toEqual([]);
  });

  it("stops when the signal aborts", async () => {
    process.env.FAKE_PG_DUMP_MODE = "hang";
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(runBackup(baseOptions({ signal: controller.signal }))).rejects.toMatchObject({ code: "aborted" });
  });

  it("reports a missing pg_dump binary", async () => {
    await expect(runBackup(baseOptions({ pgDump: [path.join(dir, "no-such-pg_dump")] }))).rejects.toMatchObject({ code: "start_failed" });
    expect(fs.readdirSync(backups)).toEqual([]);
  });

  it("rejects a bad DATABASE_URL before touching the disk", async () => {
    await expect(runBackup(baseOptions({ databaseUrl: "nope" }))).rejects.toMatchObject({ code: "invalid_url" });
    expect(fs.existsSync(backups)).toBe(false);
  });
});

describe("listBackups", () => {
  it("returns [] for a directory that does not exist", async () => {
    expect(await listBackups(path.join(dir, "missing"))).toEqual([]);
  });
});

describe("runBackup with a config archive", () => {
  const configDirs = () => ({ config: path.join(dir, "app/data/config"), profile: path.join(dir, "app/data/profile") });
  const seedConfig = (): void => {
    fs.mkdirSync(configDirs().config, { recursive: true });
    fs.mkdirSync(configDirs().profile, { recursive: true });
    fs.writeFileSync(path.join(configDirs().config, "schedule.yaml"), "timezone: UTC\n");
    fs.writeFileSync(path.join(configDirs().profile, "me.yaml"), "name: Test\n");
  };

  it("writes <dump>.config.tgz (0600) after the dump, and listBackups reports hasConfig", async () => {
    process.env.FAKE_PG_DUMP_MODE = "ok";
    seedConfig();
    const result = await runBackup(baseOptions({ configArchive: { dirs: configDirs() } }));
    expect(result.configFile).toBe("jobradar-20261007-033000.config.tgz");
    expect(result.configWarning).toBeNull();
    expect(fs.readdirSync(backups).sort()).toEqual(["jobradar-20261007-033000.config.tgz", "jobradar-20261007-033000.dump"]);
    expect(fs.statSync(path.join(backups, result.configFile ?? "")).mode & 0o777).toBe(0o600);
    expect((await listBackups(backups))[0]?.hasConfig).toBe(true);
  });

  it("writes no archive unless asked", async () => {
    process.env.FAKE_PG_DUMP_MODE = "ok";
    const result = await runBackup(baseOptions());
    expect(result.configFile).toBeNull();
    expect(result.configWarning).toBeNull();
    expect((await listBackups(backups))[0]?.hasConfig).toBe(false);
  });

  it("keeps the dump and reports a warning when the archive cannot be written", async () => {
    process.env.FAKE_PG_DUMP_MODE = "ok";
    seedConfig();
    const failing = (): Writable => new Writable({ write: (_c, _e, cb) => cb(Object.assign(new Error("disk full"), { code: "ENOSPC" })) });
    const result = await runBackup(baseOptions({ configArchive: { dirs: configDirs(), createDestination: failing } }));
    expect(result.configFile).toBeNull();
    expect(result.configWarning).toContain("ENOSPC");
    expect(fs.readdirSync(backups)).toEqual(["jobradar-20261007-033000.dump"]);
  });

  it("warns, but still succeeds, when there is no config to archive", async () => {
    process.env.FAKE_PG_DUMP_MODE = "ok";
    const result = await runBackup(baseOptions({ configArchive: { dirs: configDirs() } }));
    expect(result.file).toBe("jobradar-20261007-033000.dump");
    expect(result.configWarning).not.toBeNull();
  });

  it("uses fileName, and skips retention with applyRetention: false", async () => {
    process.env.FAKE_PG_DUMP_MODE = "ok";
    fs.mkdirSync(backups, { recursive: true });
    fs.writeFileSync(path.join(backups, "jobradar-20260101-033000.dump"), "PGDMP old");
    const result = await runBackup(
      baseOptions({ fileName: "jobradar-manual-20261007-033000-premigrate-3-5.dump", applyRetention: false, policy: { keepDaily: 1, keepWeekly: 0 } }),
    );
    expect(result.file).toBe("jobradar-manual-20261007-033000-premigrate-3-5.dump");
    expect(result.removed).toEqual([]);
    expect(fs.readdirSync(backups).sort()).toEqual(["jobradar-20260101-033000.dump", "jobradar-manual-20261007-033000-premigrate-3-5.dump"]);
  });

  it("refuses a file name with a path or the wrong extension", async () => {
    process.env.FAKE_PG_DUMP_MODE = "ok";
    await expect(runBackup(baseOptions({ fileName: "../escape.dump" }))).rejects.toMatchObject({ code: "io" });
    await expect(runBackup(baseOptions({ fileName: "x.sql" }))).rejects.toMatchObject({ code: "io" });
  });
});

describe("retention with config archives", () => {
  const touch = (name: string): void => {
    fs.mkdirSync(backups, { recursive: true });
    fs.writeFileSync(path.join(backups, name), name.endsWith(".dump") ? "PGDMP" : "x");
  };

  it("removes the config archive together with its dump and cleans scheduled archives whose dump is gone", async () => {
    touch("jobradar-20261001-033000.dump");
    touch("jobradar-20261001-033000.config.tgz");
    touch("jobradar-20261007-033000.dump");
    touch("jobradar-20261007-033000.config.tgz");
    touch("jobradar-20260101-033000.config.tgz"); // orphan
    touch("jobradar-manual-20250101-000000.config.tgz"); // manual: never cleaned here
    const result = await applyRetention(backups, { keepDaily: 1, keepWeekly: 0 });
    expect(result.removed).toEqual(["jobradar-20261001-033000.dump"]);
    expect(fs.readdirSync(backups).sort()).toEqual([
      "jobradar-20261007-033000.config.tgz",
      "jobradar-20261007-033000.dump",
      "jobradar-manual-20250101-000000.config.tgz",
    ]);
  });

  it("applySystemRetention keeps the newest N of each safety kind with their archives and never touches other manual backups", async () => {
    const names = [
      "jobradar-manual-20261001-010000-premigrate-3-4.dump",
      "jobradar-manual-20261002-010000-premigrate-4-5.dump",
      "jobradar-manual-20261003-010000-premigrate-5-6.dump",
      "jobradar-manual-20261001-010000-pre-deploy.dump",
      "jobradar-manual-20261002-010000-pre-deploy.dump",
      "jobradar-manual-20261001-010000.dump",
      "jobradar-manual-20261001-010000-my-own-label.dump",
    ];
    for (const name of names) {
      touch(name);
      touch(name.replace(/\.dump$/, ".config.tgz"));
    }
    const result = await applySystemRetention(backups, 1);
    expect(result.removed.sort()).toEqual(["jobradar-manual-20261001-010000-pre-deploy.dump", "jobradar-manual-20261001-010000-premigrate-3-4.dump", "jobradar-manual-20261002-010000-premigrate-4-5.dump"]);
    expect(fs.existsSync(path.join(backups, "jobradar-manual-20261001-010000-pre-deploy.config.tgz"))).toBe(false);
    expect(fs.existsSync(path.join(backups, "jobradar-manual-20261003-010000-premigrate-5-6.config.tgz"))).toBe(true);
    expect(fs.existsSync(path.join(backups, "jobradar-manual-20261001-010000.dump"))).toBe(true);
    expect(fs.existsSync(path.join(backups, "jobradar-manual-20261001-010000-my-own-label.dump"))).toBe(true);
  });
});

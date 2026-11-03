// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { pruneConfigBackups, resetConfigCache } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";
import { runConfigScript } from "./run-script";

let tmp: TempConfig;
beforeEach(() => { tmp = makeTempConfig(); });
afterEach(() => tmp.cleanup());

const backupRoot = () => path.join(tmp.configDir, ".backup");
const stamp = (day: number) => `2026-10-${String(day).padStart(2, "0")}T08-00-00Z`;
const listed = () => fs.readdirSync(backupRoot()).sort();

/** `count` timestamped backup directories (days 1..count), each with a file in it. */
function putBackups(count: number): string[] {
  const names = Array.from({ length: count }, (_, index) => stamp(index + 1));
  for (const name of names) {
    fs.mkdirSync(path.join(backupRoot(), name), { recursive: true });
    fs.writeFileSync(path.join(backupRoot(), name, "ui.yaml"), "old\n");
  }
  return names;
}

function setKeep(keep: number): void {
  const file = path.join(tmp.configDir, "schedule.yaml");
  const value = parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  value.config_writes = { backups_keep: keep, lock_wait_seconds: 10 };
  fs.writeFileSync(file, stringify(value));
  resetConfigCache();
}

/** An old-format notify.yaml, so that `config:migrate --write` has something to write (and so makes a backup of its own). */
function putOldNotify(): void {
  fs.copyFileSync(path.resolve(import.meta.dirname, "../fixtures/config/notify.v1.yaml"), path.join(tmp.configDir, "notify.yaml"));
}

describe("pruneConfigBackups", () => {
  it("keeps the newest `backups_keep` timestamped directories and removes the older ones", async () => {
    const names = putBackups(7);
    setKeep(3);
    const removed = await pruneConfigBackups();
    expect(removed.map((dir) => path.basename(dir)).sort()).toEqual(names.slice(0, 4));
    expect(listed()).toEqual(names.slice(4));
  });

  it("leaves everything alone when there are no more than the limit", async () => {
    const names = putBackups(3);
    setKeep(3);
    expect(await pruneConfigBackups()).toEqual([]);
    expect(listed()).toEqual(names);
  });

  it("only counts and removes timestamped directories: the editor's backups and stray files stay", async () => {
    const names = putBackups(3);
    fs.mkdirSync(path.join(backupRoot(), "editor"), { recursive: true });
    fs.writeFileSync(path.join(backupRoot(), "editor", "ui.yaml.1"), "editor copy\n");
    fs.writeFileSync(path.join(backupRoot(), "note.txt"), "x\n");
    fs.mkdirSync(path.join(backupRoot(), "2026-10-01T08-00-00"), { recursive: true });
    setKeep(1);
    await pruneConfigBackups();
    expect(listed()).toEqual(["2026-10-01T08-00-00", "editor", "note.txt", names[2]].sort());
    expect(fs.existsSync(path.join(backupRoot(), "editor", "ui.yaml.1"))).toBe(true);
  });

  it("does nothing when there is no .backup directory", async () => {
    expect(await pruneConfigBackups()).toEqual([]);
    expect(fs.existsSync(backupRoot())).toBe(false);
  });

  it("uses the default limit when schedule.yaml cannot be read", async () => {
    putBackups(9);
    fs.writeFileSync(path.join(tmp.configDir, "schedule.yaml"), "config_writes: [not, a, map\n");
    resetConfigCache();
    const removed = await pruneConfigBackups();
    expect(removed).toHaveLength(4);
    expect(listed()).toHaveLength(5);
  });
});

describe("pnpm config:migrate and the backups", () => {
  it("--write never prunes, --prune-backups does", () => {
    const names = putBackups(6);
    setKeep(2);
    putOldNotify();
    const written = runConfigScript(tmp, "config-migrate.ts", ["--write"]);
    expect(written.status).toBe(0);
    // the backup of this run joined the old ones; nothing was removed
    expect(listed()).toEqual(expect.arrayContaining(names));
    expect(listed()).toHaveLength(names.length + 1);

    const pruned = runConfigScript(tmp, "config-migrate.ts", ["--prune-backups"]);
    expect(pruned.status).toBe(0);
    expect(pruned.out).toContain("removed 5 old backup(s)");
    expect(listed()).toHaveLength(2);
    // the backup the run just made is the newest one and survives
    expect(listed()).toContain(names[5]);
  });

  it("--prune-backups with nothing to remove says so and exits 0", () => {
    putBackups(1);
    const result = runConfigScript(tmp, "config-migrate.ts", ["--prune-backups"]);
    expect(result.status).toBe(0);
    expect(result.out).toContain("no backups to remove");
  });

  it("--prune-backups cannot be combined with --write", () => {
    expect(runConfigScript(tmp, "config-migrate.ts", ["--prune-backups", "--write"]).status).toBe(2);
  });
});

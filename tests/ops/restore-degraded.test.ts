// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installConfigReader, pathWithoutNode, removeTsxLoader } from "./config-reader";

/**
 * scripts/ops/restore.sh in the degraded mode: the validated config cannot be read (no node, no tsx loader, config-get
 * fails). Backups are then ordered and aged by their modification time (UTC), never by the zone in their names, the age
 * limit comes from the shell reader (else 30 h), and a loud warning says so. The drop of replaced databases (none in this
 * mode) is covered next to the other main-database cases in restore-script.test.ts.
 */
const REPO = path.resolve(import.meta.dirname, "../..");
const NOW = Date.now();
const TOOLS = ["bash", "awk", "basename", "cat", "date", "dirname", "env", "grep", "head", "iconv", "ls", "mkdir", "printf", "rm", "sed", "sort", "stat", "tr", "wc"];

let tmp = "";
let app = "";
let stubs = "";
let backups = "";

function write(file: string, content: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "restore-degraded-"));
  app = path.join(tmp, "checkout");
  stubs = path.join(tmp, "bin");
  backups = path.join(app, "data/backups");
  write(path.join(app, "scripts/ops/restore.sh"), fs.readFileSync(path.join(REPO, "scripts/ops/restore.sh"), "utf8"), 0o755);
  write(path.join(app, "scripts/ops/lib/ai-worker.sh"), fs.readFileSync(path.join(REPO, "scripts/ops/lib/ai-worker.sh"), "utf8"));
  write(path.join(app, "scripts/ops/lib/timezone.sh"), fs.readFileSync(path.join(REPO, "scripts/ops/lib/timezone.sh"), "utf8"));
  write(path.join(app, "config/schedule.yaml"), "timezone: UTC\nbackup:\n  max_age_hours: 30\n");
  write(path.join(stubs, "docker"), "#!/usr/bin/env bash\nexit 0\n", 0o755); // `ps` prints nothing: the db is "not running"
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

interface Run {
  env?: Record<string, string>;
  noLoader?: boolean;
  noNode?: boolean;
}

function restore(args: string[], run: Run = {}) {
  installConfigReader(app, stubs);
  if (run.noLoader === true) removeTsxLoader(app);
  let searchPath = `${stubs}:${process.env.PATH ?? ""}`;
  if (run.noNode === true) {
    fs.rmSync(path.join(stubs, "node"));
    searchPath = pathWithoutNode(searchPath, path.join(tmp, "tools"), TOOLS);
  }
  return spawnSync("bash", [path.join(app, "scripts/ops/restore.sh"), ...args], {
    encoding: "utf8",
    input: "",
    timeout: 30_000,
    env: { ...process.env, PATH: searchPath, JOB_RADAR_ZONEINFO_DIR: "/nonexistent-zoneinfo", ...run.env },
  });
}

/**
 * Two backups whose names and modification times disagree: by name (in the schedule's zone, Pacific/Kiritimati = UTC+14)
 * the manual one is newer, by modification time the scheduled one is (1 min old; the manual one 2 h).
 */
function backupsDisagreeing(): { scheduled: string; manual: string } {
  fs.rmSync(backups, { recursive: true, force: true });
  const stamp = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000 + 14 * 3_600_000).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const scheduled = `jobradar-${stamp(30)}.dump`;
  const manual = `jobradar-manual-${stamp(5)}.dump`;
  write(path.join(backups, scheduled), "PGDMP");
  write(path.join(backups, manual), "PGDMP");
  fs.utimesSync(path.join(backups, scheduled), new Date(NOW - 60_000), new Date(NOW - 60_000));
  fs.utimesSync(path.join(backups, manual), new Date(NOW - 7_200_000), new Date(NOW - 7_200_000));
  return { scheduled, manual };
}

const listed = (stdout: string): string[] =>
  stdout
    .split("\n")
    .map((line) => line.split(/\s+/)[0] ?? "")
    .filter((name) => name.startsWith("jobradar-"));

describe("restore.sh in the degraded mode", () => {
  beforeAll(() => write(path.join(app, "data/config/schedule.yaml"), "timezone: Pacific/Kiritimati\nbackup:\n  max_age_hours: 40\n  keep_old_databases: 3\n"));

  it("normally orders by the names in the schedule's zone, without a warning", () => {
    const { scheduled, manual } = backupsDisagreeing();
    const r = restore(["--list"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("WARNING");
    expect(listed(r.stdout)).toEqual([manual, scheduled]);
  });

  it.each([
    { name: "no node", run: { noNode: true }, says: "node is not installed" },
    { name: "no tsx loader", run: { noLoader: true }, says: "run pnpm install" },
    { name: "config-get fails", run: { env: { STUB_NODE_EXIT: "1" } }, says: "invalid (stub)" },
  ])("$name: orders by modification time, warns loudly", ({ run, says }) => {
    const { scheduled, manual } = backupsDisagreeing();
    const r = restore(["--list"], run);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain(says);
    expect(r.stderr).toContain("!!! WARNING: degraded mode");
    expect(r.stderr).toContain("modification time (UTC)");
    expect(listed(r.stdout)).toEqual([scheduled, manual]);
  });

  it("--latest picks the newest by modification time and ages it by that", () => {
    const { scheduled } = backupsDisagreeing();
    const r = restore(["--latest"], { env: { STUB_NODE_EXIT: "1" } });
    expect(r.stdout).toContain(`== newest backup: ${scheduled} (age 1 min; limit 40 h)`);
  });

  it.each([
    { name: "the shell reader's backup.max_age_hours", schedule: "timezone: UTC\nbackup:\n  max_age_hours: 40\n", limit: "40 h" },
    { name: "30 h when it is unclear", schedule: "timezone: UTC\nbackup:\n  max_age_hours: [40]\n", limit: "30 h" },
    { name: "30 h when it is missing", schedule: "timezone: UTC\n", limit: "30 h" },
  ])("the age limit is $name", ({ schedule, limit }) => {
    write(path.join(app, "data/config/schedule.yaml"), schedule);
    try {
      backupsDisagreeing();
      const r = restore(["--latest"], { env: { STUB_NODE_EXIT: "1" } });
      expect(r.stdout).toContain(`limit ${limit})`);
    } finally {
      write(path.join(app, "data/config/schedule.yaml"), "timezone: Pacific/Kiritimati\nbackup:\n  max_age_hours: 40\n  keep_old_databases: 3\n");
    }
  });

  it("--max-age-hours still wins", () => {
    backupsDisagreeing();
    const r = restore(["--latest", "--max-age-hours", "7"], { env: { STUB_NODE_EXIT: "1" } });
    expect(r.stdout).toContain("limit 7 h)");
  });
});

// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installConfigReader, pathWithoutNode, removeTsxLoader } from "./config-reader";

/**
 * scripts/ops/backup.sh never refuses a backup because of the config: when the validated config cannot be read it falls
 * back to the shell reader, and when that cannot read a valid `timezone` either, to UTC; always with a loud warning, a
 * backup written, exit 0 and no older backup removed. A stub `docker` plays the db container.
 */
const REPO = path.resolve(import.meta.dirname, "../..");

let tmp = "";
let app = "";
let stubs = "";

function write(file: string, content: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "backup-config-"));
  app = path.join(tmp, "checkout");
  stubs = path.join(tmp, "bin");
  write(path.join(app, "scripts/ops/backup.sh"), fs.readFileSync(path.join(REPO, "scripts/ops/backup.sh"), "utf8"), 0o755);
  write(path.join(app, "scripts/ops/lib/timezone.sh"), fs.readFileSync(path.join(REPO, "scripts/ops/lib/timezone.sh"), "utf8"));
  write(path.join(app, "config/schedule.yaml"), "timezone: Etc/GMT+12\n");
  write(
    path.join(stubs, "docker"),
    `#!/usr/bin/env bash
if [[ "$*" == *"ps --status running --services"* ]]; then echo db; exit 0; fi
if [[ "$*" == *pg_dump* ]]; then printf 'PGDMP-body'; exit 0; fi
if [[ "$*" == *"pg_restore --list"* ]]; then cat > /dev/null; exit 0; fi
exit 0
`,
    0o755,
  );
  write(path.join(stubs, "sync"), "#!/usr/bin/env bash\nexit 0\n", 0o755);
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

interface Run {
  env?: Record<string, string>;
  /** Leave out the tsx loader (a checkout before `pnpm install`). */
  noLoader?: boolean;
  /** No node anywhere on PATH (neither the fake nor a real one). */
  noNode?: boolean;
}

/** Run backup.sh into a new directory that already holds two older backups. */
function backup(userSchedule: string | Buffer | null, run: Run = {}) {
  installConfigReader(app, stubs);
  if (run.noLoader === true) removeTsxLoader(app);
  const user = path.join(app, "data/config/schedule.yaml");
  fs.rmSync(user, { force: true });
  if (userSchedule !== null) {
    fs.mkdirSync(path.dirname(user), { recursive: true });
    fs.writeFileSync(user, userSchedule);
  }
  const dir = fs.mkdtempSync(path.join(tmp, "out-"));
  const older = ["jobradar-20200101-000000.dump", "jobradar-manual-20200101-000000.dump"];
  for (const name of older) write(path.join(dir, name), "PGDMP-old");
  let searchPath = `${stubs}:${process.env.PATH ?? ""}`;
  if (run.noNode === true) {
    fs.rmSync(path.join(stubs, "node"));
    searchPath = pathWithoutNode(searchPath, path.join(tmp, "tools"), TOOLS);
  }
  const r = spawnSync("bash", [path.join(app, "scripts/ops/backup.sh"), "--dir", dir, "--label", "cfg"], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, PATH: searchPath, JOB_RADAR_ZONEINFO_DIR: "/nonexistent-zoneinfo", ...run.env },
  });
  const files = fs.readdirSync(dir);
  const dump = files.find((name) => name.endsWith("-cfg.dump")) ?? "";
  return { ...r, files, dump, older };
}
/** What backup.sh and its libraries run, reached without the directories that hold a node. */
const TOOLS = ["bash", "awk", "basename", "cat", "chmod", "date", "dirname", "env", "grep", "gzip", "head", "iconv", "mkdir", "mv", "rm", "sed", "sort", "tar", "tr", "wc"];

/** Seconds between now and the stamp in a dump name read as the wall clock of a zone `offsetHours` from UTC. */
function skewSeconds(dump: string, offsetHours: number): number {
  const m = /(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-cfg\.dump$/.exec(dump);
  if (!m) return Number.POSITIVE_INFINITY;
  const [, y, mo, d, h, mi, s] = m.map(Number) as [number, number, number, number, number, number, number];
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s) - offsetHours * 3600_000;
  return Math.abs(asUtc - Date.now()) / 1000;
}

function expectWritten(r: ReturnType<typeof backup>): void {
  expect(r.status, r.stderr).toBe(0);
  expect(r.dump).not.toBe("");
  expect(r.stdout).toContain("backup written:");
  for (const name of r.older) expect(r.files, name).toContain(name);
}

describe("backup.sh when the validated config cannot be read", () => {
  it("normally takes the zone from cfg_get, without a warning", () => {
    const r = backup("timezone: Pacific/Kiritimati\n");
    expectWritten(r);
    expect(r.stderr).not.toContain("WARNING");
    expect(skewSeconds(r.dump, 14)).toBeLessThan(120);
  });

  it.each([
    { name: "config-get fails (an invalid config)", run: { env: { STUB_NODE_EXIT: "1" } }, says: "invalid (stub)" },
    { name: "no node_modules (no tsx loader)", run: { noLoader: true }, says: "run pnpm install" },
    { name: "no node", run: { noNode: true }, says: "node is not installed" },
  ])("$name: the shell reader's zone, a loud warning, the backup written", ({ run, says }) => {
    const r = backup("timezone: Pacific/Kiritimati\n", run);
    expectWritten(r);
    expect(r.stderr).toContain(says);
    expect(r.stderr).toContain("!!! WARNING");
    expect(r.stderr).toContain("'Pacific/Kiritimati' was read from schedule.yaml by the shell reader");
    expect(skewSeconds(r.dump, 14)).toBeLessThan(120);
  });

  it.each([
    { name: "timezone is missing", schedule: "backup:\n  max_age_hours: 3\n" },
    { name: "timezone is unclear (flow style)", schedule: "timezone: [Pacific/Kiritimati]\n" },
    { name: "timezone fails its check", schedule: "timezone: Japan\n" },
    { name: "the file is not UTF-8", schedule: Buffer.concat([Buffer.from("timezone: Pacific/Kiritimati\nnote: caf"), Buffer.from([0xe9]), Buffer.from("\n")]) },
  ])("config-get fails and $name: UTC, a loud warning, the backup still written", ({ schedule }) => {
    const r = backup(schedule, { env: { STUB_NODE_EXIT: "1" } });
    expectWritten(r);
    expect(r.stderr).toContain("!!! WARNING");
    expect(r.stderr).toContain("carries UTC");
    expect(skewSeconds(r.dump, 0)).toBeLessThan(120);
  });
});

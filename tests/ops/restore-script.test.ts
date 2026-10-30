// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tarChunks } from "@/lib/ops/tar";

import { installConfigReader } from "./config-reader";

/**
 * scripts/ops/restore.sh backup selection (--latest, --list, the age gate), run against a throw-away checkout with a
 * stub `docker` that reports the db service as stopped: the script stops right after the selection, so nothing is
 * ever restored and no real stack is touched.
 */
const realScript = path.resolve(import.meta.dirname, "../../scripts/ops/restore.sh");
const realLib = path.resolve(import.meta.dirname, "../../scripts/ops/lib/ai-worker.sh");
const realTzLib = path.resolve(import.meta.dirname, "../../scripts/ops/lib/timezone.sh");

let tmp = "";
let app = "";
let backups = "";
let stubs = "";

function write(file: string, content: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

const NOW = Date.now();
const pad = (n: number) => String(n).padStart(2, "0");
/** File-name stamp "YYYYMMDD-HHMMSS" for `hoursAgo` hours before now, in UTC (the test schedule's zone). */
function stampAgo(hoursAgo: number): string {
  const d = new Date(NOW - hoursAgo * 3_600_000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function reset(files: Record<string, number>): void {
  fs.rmSync(backups, { recursive: true, force: true });
  for (const [name, hoursAgo] of Object.entries(files)) {
    write(path.join(backups, name.replace("{STAMP}", stampAgo(hoursAgo))), "PGDMP");
  }
}

const restore = (...args: string[]) =>
  spawnSync("bash", [path.join(app, "scripts/ops/restore.sh"), ...args], {
    encoding: "utf8",
    input: "", // not a terminal: no prompt can be answered
    env: { ...process.env, PATH: `${stubs}:${process.env.PATH ?? ""}` },
    timeout: 30_000,
  });

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "restore-script-"));
  app = path.join(tmp, "checkout");
  backups = path.join(app, "data/backups");
  stubs = path.join(tmp, "bin");
  write(path.join(app, "scripts/ops/restore.sh"), fs.readFileSync(realScript, "utf8"), 0o755);
  write(path.join(app, "scripts/ops/lib/ai-worker.sh"), fs.readFileSync(realLib, "utf8"));
  write(path.join(app, "scripts/ops/lib/timezone.sh"), fs.readFileSync(realTzLib, "utf8"));
  installConfigReader(app, stubs);
  write(path.join(app, "config/schedule.yaml"), "timezone: UTC\nbackup:\n  enabled: true\n  max_age_hours: 30\n");
  write(path.join(stubs, "docker"), "#!/usr/bin/env bash\nexit 0\n", 0o755); // `ps` prints nothing: the db is "not running"
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("scripts/ops/restore.sh backup selection", () => {
  it("passes bash -n", () => {
    expect(spawnSync("bash", ["-n", realScript]).status).toBe(0);
  });

  it("--latest picks the newest backup by the date in the name, not by name order: a scheduled one beats an older manual one", () => {
    // by name, "jobradar-manual-…" sorts after "jobradar-2026…" and used to win
    reset({
      "jobradar-{STAMP}.dump": 2,
      "jobradar-manual-{STAMP}-pre-deploy.dump": 20,
      "jobradar-manual-{STAMP}.dump": 40,
    });
    const r = restore("--latest");
    expect(r.stdout).toContain(`jobradar-${stampAgo(2)}.dump`);
    expect(r.stdout).not.toContain("pre-deploy");
    expect(r.stdout).toMatch(/age 2 h/);
    expect(r.stderr).not.toContain("WARNING");
    expect(r.stderr).toContain("the db service is not running");
  });

  it("--latest picks a manual backup when it is the newest", () => {
    reset({ "jobradar-{STAMP}.dump": 10, "jobradar-manual-{STAMP}-pre-restore.dump": 1 });
    const r = restore("--latest");
    expect(r.stdout).toContain("-pre-restore.dump");
  });

  it("--latest refuses an old backup without confirmation", () => {
    reset({ "jobradar-{STAMP}.dump": 100 });
    const r = restore("--latest");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("WARNING");
    expect(r.stderr).toContain("pass --yes");
    expect(r.stderr).not.toContain("the db service is not running");
  });

  it("--latest --yes accepts an old backup but warns loudly", () => {
    reset({ "jobradar-{STAMP}.dump": 100 });
    const r = restore("--latest", "--yes");
    expect(r.stderr).toContain("WARNING");
    expect(r.stderr).toContain("the db service is not running");
  });

  it("--max-age-hours with a leading zero (08) is decimal, not octal", () => {
    reset({ "jobradar-{STAMP}.dump": 2 });
    const r = restore("--latest", "--max-age-hours", "08");
    expect(r.stderr).not.toContain("value too great");
    expect(r.stdout).toContain("limit 8 h");
    expect(r.stderr).toContain("the db service is not running");
  });

  it("the age limit is configurable: --max-age-hours and schedule.yaml", () => {
    reset({ "jobradar-{STAMP}.dump": 40 });
    expect(restore("--latest").status).toBe(1); // 40 h > 30 h from schedule.yaml
    expect(restore("--latest", "--max-age-hours", "48").stderr).toContain("the db service is not running");
  });

  it("--latest on an empty directory fails clearly", () => {
    reset({});
    fs.mkdirSync(backups, { recursive: true });
    const r = restore("--latest");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no backups");
  });

  it("without time zone data for the schedule's zone it warns and orders by modification time instead of trusting the names", () => {
    const schedule = path.join(app, "config/schedule.yaml");
    const original = fs.readFileSync(schedule, "utf8");
    try {
      write(schedule, original.replace("timezone: UTC", "timezone: Nowhere/Fakeland"));
      reset({ "jobradar-{STAMP}.dump": 30, "jobradar-manual-{STAMP}.dump": 5 });
      // the names say the manual one is newer; the files say the scheduled one is
      const scheduled = fs.readdirSync(backups).find((n) => !n.includes("manual")) ?? "";
      const manual = fs.readdirSync(backups).find((n) => n.includes("manual")) ?? "";
      fs.utimesSync(path.join(backups, scheduled), new Date(NOW - 60_000), new Date(NOW - 60_000));
      fs.utimesSync(path.join(backups, manual), new Date(NOW - 7_200_000), new Date(NOW - 7_200_000));
      const r = restore("--list");
      expect(r.stderr).toContain("no time zone data for 'Nowhere/Fakeland'");
      const names = r.stdout
        .split("\n")
        .map((l) => l.split(/\s+/)[0] ?? "")
        .filter((n) => n.startsWith("jobradar-"));
      expect(names).toEqual([scheduled, manual]);
    } finally {
      write(schedule, original);
    }
  });

  it("reads the modification time with GNU stat (where `stat -f` prints a file system report and fails)", () => {
    const schedule = path.join(app, "config/schedule.yaml");
    const original = fs.readFileSync(schedule, "utf8");
    const statStub = path.join(stubs, "stat");
    // GNU-like: `-c %Y` works, `-f ...` prints a multi-line report to stdout and exits 1. The real stat serves `-c %Y`
    // (or, on a BSD stat that has no -c, its own `-f %m`).
    write(
      statStub,
      [
        "#!/usr/bin/env bash",
        'if [[ "$1" == "-c" ]]; then',
        '  if /usr/bin/stat -c %Y / >/dev/null 2>&1; then exec /usr/bin/stat "$@"; fi',
        '  exec /usr/bin/stat -f %m "$3"',
        "fi",
        'echo "  File: \"$2\""; echo "    ID: 0 Namelen: 255 Type: ext2/ext3"; echo "Block size: 4096"',
        "exit 1",
        "",
      ].join("\n"),
      0o755,
    );
    try {
      write(schedule, original.replace("timezone: UTC", "timezone: Nowhere/Fakeland"));
      reset({ "jobradar-{STAMP}.dump": 30, "jobradar-manual-{STAMP}.dump": 5 });
      const scheduled = fs.readdirSync(backups).find((n) => !n.includes("manual")) ?? "";
      const manual = fs.readdirSync(backups).find((n) => n.includes("manual")) ?? "";
      fs.utimesSync(path.join(backups, scheduled), new Date(NOW - 60_000), new Date(NOW - 60_000));
      fs.utimesSync(path.join(backups, manual), new Date(NOW - 7_200_000), new Date(NOW - 7_200_000));
      const r = restore("--list");
      expect(r.status, r.stderr).toBe(0);
      const names = r.stdout
        .split("\n")
        .map((l) => l.split(/\s+/)[0] ?? "")
        .filter((n) => n.startsWith("jobradar-"));
      expect(names).toEqual([scheduled, manual]);
      expect(r.stdout).not.toContain("Namelen");
    } finally {
      fs.rmSync(statStub, { force: true });
      write(schedule, original);
    }
  });

  it("--list shows every backup newest first with its age, and whether a config archive sits next to it", () => {
    reset({
      "jobradar-{STAMP}.dump": 30,
      "jobradar-manual-{STAMP}-pre-deploy.dump": 5,
      "jobradar-manual-{STAMP}.dump": 60,
    });
    write(path.join(backups, `jobradar-manual-${stampAgo(5)}-pre-deploy.config.tgz`), "x");
    const r = restore("--list");
    expect(r.status, r.stderr).toBe(0);
    const names = r.stdout
      .split("\n")
      .map((l) => /^(jobradar\S+\.dump)/.exec(l)?.[1])
      .filter(Boolean);
    expect(names).toEqual([`jobradar-manual-${stampAgo(5)}-pre-deploy.dump`, `jobradar-${stampAgo(30)}.dump`, `jobradar-manual-${stampAgo(60)}.dump`]);
    expect(r.stdout).toMatch(/pre-deploy\.dump\s+yes\s+5 h/);
  });
});

/**
 * Restoring into the main database, against a stub `docker` (and `systemctl` / `launchctl` / `uname`) that records every
 * call. The stub plays the db container; nothing here touches a real database or service.
 */
describe("scripts/ops/restore.sh into the main database", () => {
  let root = "";
  let checkout = "";
  let bin = "";
  let log = "";
  let dump = "";

  const DOCKER_STUB = `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
args="$*"
# STUB_KILL_ON: the matching docker call finishes, then the script gets SIGTERM (what Ctrl-C / kill does while a command runs)
if [[ -n "\${STUB_KILL_ON:-}" && "$args" == *"\${STUB_KILL_ON}"* ]]; then kill -TERM $PPID; fi
case "$args" in
  *"ps --status running --services"*) echo db ;;
  *"select 1 from pg_database where datname = 'jobradar_before_restore_"*) [[ "\${STUB_OLD_EXISTS:-}" == 1 ]] && echo 1 ;;
  *"select 1 from pg_database where datname = 'jobradar'"*)
    # STUB_MAIN_GONE: the main database is missing until a (successful) rename of the old one back to its name was logged
    if [[ "\${STUB_MAIN_GONE:-}" != 1 ]] || { [[ "\${STUB_FAIL_BACK:-}" != 1 ]] && grep -q 'alter database "jobradar_before_restore_[0-9]*" rename to "jobradar"' "$STUB_LOG"; }; then echo 1; fi ;;
  *POSTGRES_USER*) printf jobradar ;;
  *POSTGRES_DB*) printf jobradar ;;
  *"pg_restore --list"*) [[ "\${STUB_FAIL_LIST:-}" == 1 ]] && exit 1 ;;
  *"pg_restore --no-owner"*) cat > /dev/null; [[ "\${STUB_FAIL_RESTORE:-}" == 1 ]] && { echo "pg_restore: error: boom" >&2; exit 1; } ;;
  *pg_database_size*) echo 1000 ;;
  *"df -Pk"*) echo "\${STUB_FREE_KB:-99999999}" ;;
  *"datname = 'jobradar'"*) echo 1 ;;
  *"from pg_database where datname ="*) ;;
  *information_schema.tables*) if [[ "\${STUB_NO_MIGRATIONS:-}" == 1 ]]; then printf 'public.jobs\t5\n'; else printf 'drizzle.__drizzle_migrations\t3\npublic.jobs\t5\n'; fi ;;
  *'alter database "jobradar_before_restore_'*'rename to "jobradar"'*) [[ "\${STUB_FAIL_BACK:-}" == 1 ]] && exit 1 ;;
  *'alter database "jobradar_restore_'*) [[ "\${STUB_FAIL_SWAP:-}" == 1 ]] && exit 1 ;;
  *before_restore_*order*) printf 'jobradar_before_restore_20990101000000\njobradar_before_restore_20200102000000\njobradar_before_restore_20200101000000\n' ;;
esac
exit 0
`;

  const run = (args: string[], env: Record<string, string> = {}) => {
    fs.writeFileSync(log, "");
    return spawnSync("bash", [path.join(checkout, "scripts/ops/restore.sh"), dump, ...args], {
      encoding: "utf8",
      input: "",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, STUB_LOG: log, HOME: root, RESTORE_RENAME_RETRY_SECONDS: "0", ...env },
      timeout: 30_000,
    });
  };
  const calls = (): string[] => fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
  /** The steps of a run in short form, so the order can be asserted. */
  const steps = (): string[] =>
    calls().flatMap((line) => {
      if (/create database "jobradar_restore_/.test(line)) return ["create-temp"];
      if (/pg_restore --no-owner/.test(line)) return ["restore"];
      if (/compose stop web runner/.test(line)) return ["stop-services"];
      if (/compose start web runner/.test(line)) return ["start-services"];
      if (/^systemctl --user stop/.test(line)) return ["stop-ai-worker"];
      if (/^systemctl --user start/.test(line)) return ["start-ai-worker"];
      if (/^launchctl bootout/.test(line)) return ["stop-ai-worker"];
      if (/^launchctl bootstrap/.test(line)) return ["start-ai-worker"];
      if (/pg_terminate_backend/.test(line)) return ["terminate"];
      if (/alter database "jobradar" rename to "jobradar_before_restore_/.test(line)) return ["rename-old"];
      if (/alter database "jobradar_restore_\d+" rename to "jobradar"/.test(line)) return ["rename-new"];
      if (/alter database "jobradar_before_restore_\d+" rename to "jobradar"/.test(line)) return ["rename-back"];
      if (/drop database "jobradar_before_restore_/.test(line)) return ["drop-old"];
      if (/drop database if exists "jobradar_restore_/.test(line)) return ["drop-temp"];
      return [];
    });

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "restore-main-"));
    checkout = path.join(root, "checkout");
    bin = path.join(root, "bin");
    log = path.join(root, "stub.log");
    dump = path.join(root, "backup.dump");
    write(path.join(checkout, "scripts/ops/restore.sh"), fs.readFileSync(realScript, "utf8"), 0o755);
    write(path.join(checkout, "scripts/ops/lib/ai-worker.sh"), fs.readFileSync(realLib, "utf8"));
    write(path.join(checkout, "scripts/ops/lib/timezone.sh"), fs.readFileSync(realTzLib, "utf8"));
    installConfigReader(checkout, bin);
    write(path.join(checkout, "config/schedule.yaml"), "timezone: UTC\nbackup:\n  max_age_hours: 30\n  keep_old_databases: 1\n");
    write(path.join(checkout, "data/config/schedule.yaml"), "timezone: UTC\nbackup:\n  max_age_hours: 30\n  keep_old_databases: 1\n");
    write(path.join(checkout, "data/config/me.yaml"), "current config\n");
    write(path.join(checkout, "data/profile/me.yaml"), "current profile\n");
    write(dump, "PGDMP-body");
    write(path.join(bin, "docker"), DOCKER_STUB, 0o755);
    // `mv` that fails for the staged configuration when STUB_FAIL_MV is set, and is the real one otherwise.
    write(path.join(bin, "mv"), '#!/usr/bin/env bash\nif [[ "${STUB_FAIL_MV:-}" == 1 && "$*" == *.restore-config-* ]]; then echo "mv: simulated failure" >&2; exit 1; fi\nexec /bin/mv "$@"\n', 0o755);
    write(path.join(bin, "uname"), '#!/usr/bin/env bash\necho "${STUB_UNAME:-Linux}"\n', 0o755);
    write(
      path.join(bin, "systemctl"),
      '#!/usr/bin/env bash\necho "systemctl $*" >> "$STUB_LOG"\ncase "$*" in *cat*) [[ "${STUB_NO_UNIT:-}" == 1 ]] && exit 1 ;; *is-active*) [[ "${STUB_UNIT_INACTIVE:-}" == 1 ]] && exit 3 ;; esac\nexit 0\n',
      0o755,
    );
    write(
      path.join(bin, "launchctl"),
      '#!/usr/bin/env bash\necho "launchctl $*" >> "$STUB_LOG"\nflag="$STUB_LOG.booted-out"\ncase "$1" in print) [[ -f "$flag" ]] && exit 1 ;; bootout) : > "$flag" ;; bootstrap) rm -f "$flag" ;; esac\nexit 0\n',
      0o755,
    );
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("passes bash -n for the helper", () => {
    expect(spawnSync("bash", ["-n", realLib]).status).toBe(0);
  });

  it("restores into a temporary database first, stops everything, ends connections, swaps by two renames, restarts, and never drops the main database", () => {
    const r = run(["--target", "jobradar", "--yes"]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const order = steps();
    // the restore happens while the services still run
    expect(order.slice(0, 2)).toEqual(["create-temp", "restore"]);
    expect(order).toEqual([
      "create-temp",
      "restore",
      "stop-services",
      "stop-ai-worker",
      "terminate",
      "rename-old",
      "terminate",
      "rename-new",
      "start-services",
      "start-ai-worker",
      "drop-old",
      "drop-old",
    ]);
    expect(calls().join("\n")).not.toMatch(/drop database "jobradar"/);
    expect(calls().join("\n")).not.toMatch(/drop database "jobradar" /);
    expect(calls().some((c) => /pre-restore|backup\.sh/.test(c))).toBe(false); // no safety backup of the (maybe broken) main database
    expect(r.stdout).toContain("alter database \"jobradar\" rename to"); // the rollback commands
    expect(r.stdout).toMatch(/restored: 2 tables, 8 rows/);
  });

  it("says nothing about undoing when the run needs no undoing", () => {
    const r = run(["--target", "jobradar", "--yes"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("undoing");
    const failed = run(["--target", "jobradar", "--yes"], { STUB_FAIL_RESTORE: "1" });
    expect(failed.stderr).not.toContain("undoing");
    const noYes = run(["--target", "jobradar"]);
    expect(noYes.status).toBe(1);
    expect(noYes.stderr).not.toContain("undoing");
    expect(steps()).toEqual(["create-temp", "restore"]); // the check copy is kept on purpose
  });

  it("a backup that does not look like Job Radar keeps the checked copy for inspection instead of dropping it", () => {
    const r = run(["--target", "jobradar", "--yes"], { STUB_NO_MIGRATIONS: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not look like a Job Radar backup");
    expect(steps()).toEqual(["create-temp", "restore"]);
    expect(r.stderr).not.toContain("dropping the unfinished copy");
  });

  it("when the old database cannot be put back it exits non-zero and does not start web and runner without a main database", () => {
    const r = run(["--target", "jobradar", "--yes"], { STUB_FAIL_SWAP: "1", STUB_FAIL_BACK: "1", STUB_OLD_EXISTS: "1", STUB_MAIN_GONE: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("NOT started");
    expect(r.stderr).toContain("rename it yourself");
    expect(steps()).not.toContain("start-services");
    expect(steps()).not.toContain("start-ai-worker");
  });

  describe("interrupted (SIGTERM)", () => {
    it("while web and runner are being stopped: starts them again and drops the temporary database", () => {
      const r = run(["--target", "jobradar", "--yes"], { STUB_KILL_ON: "stop web runner" });
      expect(r.status).toBe(143);
      expect(steps()).toEqual(["create-temp", "restore", "stop-services", "drop-temp", "start-services"]);
      expect(r.stderr).toContain("undoing");
      expect(calls().join("\n")).not.toMatch(/drop database "jobradar"/);
    });

    it("between the two renames: puts the main database back, drops the copy, starts web, runner and the ai-worker", () => {
      const r = run(["--target", "jobradar", "--yes"], {
        STUB_KILL_ON: 'alter database "jobradar" rename to "jobradar_before_restore_',
        STUB_OLD_EXISTS: "1",
        STUB_MAIN_GONE: "1",
      });
      expect(r.status).toBe(143);
      expect(steps()).toEqual([
        "create-temp",
        "restore",
        "stop-services",
        "stop-ai-worker",
        "terminate",
        "rename-old",
        "terminate",
        "rename-back",
        "drop-temp",
        "start-services",
        "start-ai-worker",
      ]);
      expect(r.stderr).toContain("putting 'jobradar_before_restore_");
    });

    it("does not rename anything back when the main database is in place", () => {
      const r = run(["--target", "jobradar", "--yes"], { STUB_KILL_ON: 'alter database "jobradar" rename to "jobradar_before_restore_', STUB_OLD_EXISTS: "1" });
      expect(r.status).toBe(143);
      expect(steps()).not.toContain("rename-back");
      expect(steps()).toEqual(expect.arrayContaining(["drop-temp", "start-services"]));
    });

    it("removes the unpacked configuration when it is interrupted before the swap, and keeps the live folders", () => {
      const archive = dump.replace(/\.dump$/, ".config.tgz");
      fs.writeFileSync(archive, gzipSync(Buffer.concat([...tarChunks([{ name: "data/config/me.yaml", data: Buffer.from("x\n") }])])));
      const r = run(["--target", "jobradar", "--yes", "--with-config"], { STUB_KILL_ON: "stop web runner" });
      expect(r.status).toBe(143);
      expect(fs.readdirSync(path.join(checkout, "data")).filter((n) => n.startsWith(".restore-config-"))).toEqual([]);
      expect(fs.readFileSync(path.join(checkout, "data/config/me.yaml"), "utf8")).toBe("current config\n");
      fs.rmSync(archive, { force: true });
    });
  });

  it("keeps the newest keep_old_databases replaced databases and drops the older ones", () => {
    const r = run(["--target", "jobradar", "--yes"]);
    expect(r.status, r.stderr).toBe(0);
    const drops = calls().filter((c) => /drop database "jobradar_before_restore_/.test(c));
    expect(drops.map((c) => /before_restore_(\d+)/.exec(c)?.[1])).toEqual(["20200102000000", "20200101000000"]);
    expect(r.stdout).toContain("dropped the older replaced database");
  });

  it.each([
    { name: "config-get fails", env: { STUB_NODE_EXIT: "1" } },
    { name: "keep_old_databases: 3 in the file, config-get fails", env: { STUB_NODE_EXIT: "1" }, keep: 3 },
  ])("degraded mode ($name): restores, but drops no replaced database, with a loud warning", ({ env, keep }) => {
    const schedule = path.join(checkout, "data/config/schedule.yaml");
    const original = fs.readFileSync(schedule, "utf8");
    try {
      if (keep !== undefined) write(schedule, original.replace("keep_old_databases: 1", `keep_old_databases: ${keep}`));
      const r = run(["--target", "jobradar", "--yes"], env);
      expect(r.status, r.stderr).toBe(0);
      expect(steps()).toContain("rename-new");
      expect(steps()).not.toContain("drop-old");
      expect(calls().some((c) => /before_restore_.*order/.test(c))).toBe(false);
      expect(r.stderr).toContain("!!! WARNING: degraded mode");
      expect(r.stderr).toContain("no older replaced database was dropped");
    } finally {
      write(schedule, original);
    }
  });

  it("a failing pg_restore leaves the main database alone, stops nothing and drops the temporary copy", () => {
    const r = run(["--target", "jobradar", "--yes"], { STUB_FAIL_RESTORE: "1" });
    expect(r.status).toBe(1);
    expect(steps()).toEqual(["create-temp", "restore", "drop-temp"]);
    expect(r.stderr).toContain("was not touched");
  });

  it("a damaged archive (pg_restore --list fails) is refused before a temporary database exists", () => {
    const r = run(["--target", "jobradar", "--yes"], { STUB_FAIL_LIST: "1" });
    expect(r.status).toBe(1);
    expect(steps()).toEqual([]);
    expect(r.stderr).toContain("damaged");
  });

  it("refuses when the disk cannot hold a second copy", () => {
    const r = run(["--target", "jobradar", "--yes"], { STUB_FREE_KB: "1" });
    expect(r.status).toBe(1);
    expect(steps()).toEqual([]);
    expect(r.stderr).toContain("not enough free disk space");
  });

  it("without --yes it restores into the temporary database, shows the counts and stops before touching anything", () => {
    const r = run(["--target", "jobradar"]);
    expect(r.status).toBe(1);
    expect(steps()).toEqual(["create-temp", "restore"]);
    expect(r.stdout).toContain("restored:");
    expect(r.stderr).toContain("--yes");
  });

  it("puts the old database back when the second rename fails, and still restarts the services", () => {
    const r = run(["--target", "jobradar", "--yes"], { STUB_FAIL_SWAP: "1" });
    expect(r.status).toBe(1);
    const order = steps();
    expect(order).toContain("rename-old");
    expect(order).toContain("rename-back");
    expect(order.indexOf("rename-back")).toBeGreaterThan(order.indexOf("rename-old"));
    expect(order.slice(-2)).toEqual(["start-services", "start-ai-worker"]);
    expect(order).not.toContain("drop-old");
    expect(r.stderr).toContain("did NOT take effect");
  });

  it("--no-restart leaves web, runner and the ai-worker stopped", () => {
    const r = run(["--target", "jobradar", "--yes", "--no-restart"]);
    expect(r.status, r.stderr).toBe(0);
    expect(steps()).not.toContain("start-services");
    expect(steps()).not.toContain("start-ai-worker");
    expect(r.stdout).toContain("stay stopped");
  });

  it("a missing ai-worker unit prints a loud notice and the restore goes on", () => {
    const r = run(["--target", "jobradar", "--yes"], { STUB_NO_UNIT: "1" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("ai-worker");
    expect(r.stderr).toContain("job-radar-ai-worker.service");
    expect(steps()).not.toContain("stop-ai-worker");
    expect(steps()).toContain("rename-new");
  });

  it("an ai-worker unit that is not running is not stopped and not started", () => {
    const r = run(["--target", "jobradar", "--yes"], { STUB_UNIT_INACTIVE: "1" });
    expect(r.status, r.stderr).toBe(0);
    expect(steps()).not.toContain("stop-ai-worker");
    expect(steps()).not.toContain("start-ai-worker");
  });

  it("on macOS it boots the launchd agent out and bootstraps its plist again", () => {
    write(path.join(root, "Library/LaunchAgents/io.jobradar.ai-worker.plist"), "<plist/>");
    fs.rmSync(`${log}.booted-out`, { force: true });
    const r = run(["--target", "jobradar", "--yes"], { STUB_UNAME: "Darwin" });
    expect(r.status, r.stderr).toBe(0);
    const order = steps();
    expect(order.indexOf("stop-ai-worker")).toBeGreaterThan(order.indexOf("stop-services"));
    expect(order.indexOf("stop-ai-worker")).toBeLessThan(order.indexOf("terminate"));
    expect(order).toContain("start-ai-worker");
    expect(calls().find((c) => c.startsWith("launchctl bootout"))).toContain("io.jobradar.ai-worker");
    expect(calls().find((c) => c.startsWith("launchctl bootstrap"))).toContain("io.jobradar.ai-worker.plist");
  });

  describe("--with-config", () => {
    const archive = () => dump.replace(/\.dump$/, ".config.tgz");
    const makeArchive = (names: string[]): void => {
      const files = names.map((name) => ({ name, data: Buffer.from(`restored ${name}\n`) }));
      fs.writeFileSync(archive(), gzipSync(Buffer.concat([...tarChunks(files)])));
    };

    it.each([["../evil.txt"], ["/etc/evil.txt"], ["data/config/../../evil.txt"], ["data/other/file.txt"], ["data/configs/x"]])("refuses an archive with the member %s before anything happens", (member) => {
      makeArchive(["data/config/me.yaml", member]);
      const r = run(["--target", "jobradar", "--yes", "--with-config"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("--with-config");
      expect(calls().filter((c) => !c.startsWith("docker compose ps"))).toEqual([]);
      expect(fs.readFileSync(path.join(checkout, "data/config/me.yaml"), "utf8")).toBe("current config\n");
    });

    it.each([["symlink", "ln -s /etc/passwd data/config/link"], ["hard link", "ln data/config/me.yaml data/config/hard"]])("refuses an archive that contains a %s before anything happens", (_kind, command) => {
      const stage = fs.mkdtempSync(path.join(root, "tar-"));
      fs.mkdirSync(path.join(stage, "data/config"), { recursive: true });
      fs.writeFileSync(path.join(stage, "data/config/me.yaml"), "x\n");
      expect(spawnSync("bash", ["-c", `${command} && tar -czf '${archive()}' data`], { cwd: stage }).status).toBe(0);
      const r = run(["--target", "jobradar", "--yes", "--with-config"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("regular files and directories");
      expect(calls().filter((c) => !c.startsWith("docker compose ps"))).toEqual([]);
      expect(fs.readFileSync(path.join(checkout, "data/config/me.yaml"), "utf8")).toBe("current config\n");
    });

    it("unpacks to a staging folder first, with readable modes, and leaves nothing behind", () => {
      makeArchive(["data/config/me.yaml", "data/profile/me.yaml"]);
      const r = run(["--target", "jobradar", "--yes", "--with-config"]);
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(fs.statSync(path.join(checkout, "data/config")).mode & 0o777).toBe(0o755);
      expect(fs.statSync(path.join(checkout, "data/config/me.yaml")).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(path.join(checkout, "data")).filter((n) => n.startsWith(".restore-config-"))).toEqual([]);
    });

    it("ignores AppleDouble members (._*) in the checks and the unpacking, as in archives made by macOS tar", () => {
      makeArchive(["data/._config", "data/config/._me.yaml", "data/config/me.yaml", "data/profile/._me.yaml", "data/profile/me.yaml"]);
      const r = run(["--target", "jobradar", "--yes", "--with-config"]);
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(fs.readFileSync(path.join(checkout, "data/config/me.yaml"), "utf8")).toBe("restored data/config/me.yaml\n");
      const found = spawnSync("find", [path.join(checkout, "data"), "-name", "._*"], { encoding: "utf8" }).stdout.trim();
      expect(found).toBe("");
      // put the folders back for the tests below
      const data = path.join(checkout, "data");
      for (const name of fs.readdirSync(data)) if (name.includes(".before-restore-")) fs.rmSync(path.join(data, name), { recursive: true, force: true });
      write(path.join(data, "config/me.yaml"), "current config\n");
      write(path.join(data, "config/schedule.yaml"), "timezone: UTC\nbackup:\n  max_age_hours: 30\n  keep_old_databases: 1\n");
      write(path.join(data, "profile/me.yaml"), "current profile\n");
    });

    it("still refuses a real unsafe member next to AppleDouble ones", () => {
      makeArchive(["data/config/._me.yaml", "data/config/me.yaml", "data/other/file.txt"]);
      const r = run(["--target", "jobradar", "--yes", "--with-config"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("data/other/file.txt");
    });

    it("when putting the configuration back fails, it names the kept folders and still restarts web, runner and the ai-worker", () => {
      makeArchive(["data/config/me.yaml", "data/profile/me.yaml"]);
      const r = run(["--target", "jobradar", "--yes", "--with-config"], { STUB_FAIL_MV: "1" });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/config\.before-restore-\d+ and .*profile\.before-restore-\d+/);
      expect(r.stderr).toContain(".restore-config-");
      expect(steps()).toEqual(expect.arrayContaining(["rename-new", "start-services", "start-ai-worker"]));
      // put the folders back for the tests below
      const data = path.join(checkout, "data");
      for (const name of fs.readdirSync(data)) if (name.startsWith(".restore-config-") || name.includes(".before-restore-")) fs.rmSync(path.join(data, name), { recursive: true, force: true });
      write(path.join(data, "config/me.yaml"), "current config\n");
      write(path.join(data, "config/schedule.yaml"), "timezone: UTC\nbackup:\n  max_age_hours: 30\n  keep_old_databases: 1\n");
      write(path.join(data, "profile/me.yaml"), "current profile\n");
    });

    it("refuses when there is no archive next to the dump", () => {
      fs.rmSync(archive(), { force: true });
      const r = run(["--target", "jobradar", "--yes", "--with-config"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("no backup.config.tgz");
    });

    it("needs the main database as the target", () => {
      makeArchive(["data/config/me.yaml"]);
      const r = run(["--yes", "--with-config"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("--target");
    });

    it("renames the current folders, unpacks the archive after the swap and before the restart", () => {
      makeArchive(["data/config/me.yaml", "data/config/sub/x.yaml", "data/profile/me.yaml"]);
      const r = run(["--target", "jobradar", "--yes", "--with-config"]);
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(fs.readFileSync(path.join(checkout, "data/config/me.yaml"), "utf8")).toBe("restored data/config/me.yaml\n");
      expect(fs.readFileSync(path.join(checkout, "data/config/sub/x.yaml"), "utf8")).toBe("restored data/config/sub/x.yaml\n");
      const kept = fs.readdirSync(path.join(checkout, "data")).filter((n) => n.includes(".before-restore-"));
      expect(kept.map((n) => n.replace(/-\d+$/, "")).sort()).toEqual(["config.before-restore", "profile.before-restore"]);
      const keptConfig = kept.find((n) => n.startsWith("config."));
      expect(fs.readFileSync(path.join(checkout, "data", keptConfig ?? "", "me.yaml"), "utf8")).toBe("current config\n");
      expect(r.stdout).toContain("pnpm config:migrate --write");
    });
  });

  it("--latest says whether a config archive was found next to the backup, without --with-config it only prints the command", () => {
    fs.rmSync(dump.replace(/\.dump$/, ".config.tgz"), { force: true });
    let r = run(["--target", "jobradar_scratch"]);
    expect(r.stdout).toContain("has no config archive");
    fs.writeFileSync(dump.replace(/\.dump$/, ".config.tgz"), "x");
    r = run(["--target", "jobradar_scratch"]);
    expect(r.stdout).toContain("tar -xzf");
    expect(r.stdout).toContain("--with-config");
  });
});

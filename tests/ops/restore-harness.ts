/**
 * `scripts/ops/restore.sh --with-config` in a throw-away checkout. `docker` is a stub that plays a healthy db, and `uname`,
 * `systemctl` and `launchctl` are stubs too, so nothing here can reach the machine's services. Used by
 * restore-backfill.test.ts and archive-meta.test.ts.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { installConfigReader, pathWithoutNode } from "./config-reader";

const REPO = path.resolve(import.meta.dirname, "../..");

/** Tools restore.sh needs when node is taken off the PATH. */
const TOOLS = ["bash", "awk", "basename", "cat", "chmod", "cp", "cut", "date", "dirname", "docker", "env", "find", "grep", "gzip", "head", "iconv", "launchctl", "ln", "ls", "mkdir", "mktemp", "mv", "printf", "rm", "sed", "sleep", "sort", "stat", "systemctl", "tail", "tar", "touch", "tr", "uname", "wc", "xargs", "id", "df"];

const DOCKER_STUB = `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
case "$*" in
  *"ps --status running --services"*) echo db ;;
  *"select 1 from pg_database where datname = 'jobradar_before_restore_"*) ;;
  *"select 1 from pg_database where datname = 'jobradar'"*) echo 1 ;;
  *POSTGRES_USER*) printf jobradar ;;
  *POSTGRES_DB*) printf jobradar ;;
  *"pg_restore --no-owner"*) cat > /dev/null ;;
  *pg_database_size*) echo 1000 ;;
  *"df -Pk"*) echo 99999999 ;;
  *information_schema.tables*) printf 'drizzle.__drizzle_migrations\\t3\\npublic.jobs\\t5\\n' ;;
esac
exit 0
`;

function write(file: string, content: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

export interface RestoreHarness {
  root: string;
  checkout: string;
  /** Directory of the stubs; put in front of PATH. */
  bin: string;
  dump: string;
  /** A file under the live `data/config`. */
  live(file: string): string;
  /** Run `restore.sh <dump> --target jobradar --yes --with-config`. Asserts exit code 0. */
  restore(options?: { noNode?: boolean; pathPrefix?: string }): { stdout: string; stderr: string };
  cleanup(): void;
}

export function createRestoreHarness(): RestoreHarness {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "restore-harness-")));
  const checkout = path.join(root, "checkout");
  const bin = path.join(root, "bin");
  const dump = path.join(root, "backup.dump");
  for (const file of ["restore.sh", "lib/ai-worker.sh", "lib/timezone.sh", "lib/existing-install.sh"]) {
    write(path.join(checkout, "scripts/ops", file), fs.readFileSync(path.join(REPO, "scripts/ops", file), "utf8"), file === "restore.sh" ? 0o755 : 0o644);
  }
  installConfigReader(checkout, bin);
  const schedule = "timezone: UTC\nbackup:\n  max_age_hours: 30\n  keep_old_databases: 1\n";
  write(path.join(checkout, "config/schedule.yaml"), schedule);
  write(path.join(checkout, "data/config/schedule.yaml"), schedule);
  write(dump, "PGDMP-body");
  write(path.join(bin, "docker"), DOCKER_STUB, 0o755);
  write(path.join(bin, "uname"), "#!/usr/bin/env bash\necho Linux\n", 0o755);
  write(path.join(bin, "systemctl"), '#!/usr/bin/env bash\necho "systemctl $*" >> "$STUB_LOG"\nexit 0\n', 0o755);
  write(path.join(bin, "launchctl"), '#!/usr/bin/env bash\necho "launchctl $*" >> "$STUB_LOG"\nexit 0\n', 0o755);

  return {
    root,
    checkout,
    bin,
    dump,
    live: (file) => path.join(checkout, "data/config", file),
    restore(options = {}) {
      const log = path.join(root, "stub.log");
      fs.writeFileSync(log, "");
      let searchPath = `${options.pathPrefix === undefined ? "" : `${options.pathPrefix}:`}${bin}:${process.env.PATH ?? ""}`;
      if (options.noNode === true) {
        fs.rmSync(path.join(bin, "node"), { force: true });
        searchPath = pathWithoutNode(searchPath, path.join(root, "tools"), TOOLS);
      }
      const result = spawnSync("bash", [path.join(checkout, "scripts/ops/restore.sh"), dump, "--target", "jobradar", "--yes", "--with-config"], {
        encoding: "utf8",
        input: "",
        cwd: root,
        timeout: 120_000,
        env: { ...process.env, PATH: searchPath, STUB_LOG: log, HOME: root, RESTORE_RENAME_RETRY_SECONDS: "0", JOB_RADAR_ZONEINFO_DIR: "/nonexistent-zoneinfo" },
      });
      if (result.status !== 0) throw new Error(`restore.sh exited ${result.status}\n${result.stdout}\n${result.stderr}`);
      return { stdout: result.stdout, stderr: result.stderr };
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

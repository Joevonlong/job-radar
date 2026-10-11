import { execFileSync } from "node:child_process";

import postgres from "postgres";

/**
 * Where pg_dump / pg_restore come from in a test run. In order:
 *  1. a host binary (PG_DUMP_PATH / PG_RESTORE_PATH, or `pg_dump` / `pg_restore` on the PATH) whose major version
 *     is at least the server's (pg_dump refuses to dump a newer server);
 *  2. `docker exec` into the compose db container (JOB_RADAR_DB_CONTAINER, default job-radar-db-1), which has the
 *     server's own tools. Only when the test URL points at the compose db's published port (127.0.0.1:5433).
 * null when neither works: the dependent tests are skipped.
 */
export interface PgTools {
  mode: "host" | "docker";
  /** Command prefix for pg_dump (connection flags are appended by runBackup). */
  dump: string[];
  /** Command prefix for pg_restore; the dump is fed on stdin. */
  restore: string[];
  /** The connection URL as the tool sees the server. */
  urlFor(testUrl: string): string;
}

const PROBE_TIMEOUT_MS = 10_000;
const COMPOSE_DB_PORT = "5433";

function major(versionLine: string): number {
  const match = /(\d+)(?:\.\d+)*/.exec(versionLine.replace(/^pg_\w+ \(PostgreSQL\) /, ""));
  return Number(match?.[1] ?? Number.NaN);
}

function tryExec(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

async function serverMajor(url: string): Promise<number> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<{ v: string }[]>`select current_setting('server_version_num') as v`;
    return Math.floor(Number(row?.v) / 10_000);
  } finally {
    await sql.end({ timeout: 2 });
  }
}

export async function resolvePgTools(testUrl: string): Promise<PgTools | null> {
  const server = await serverMajor(testUrl);

  const hostDump = process.env.PG_DUMP_PATH || "pg_dump";
  const hostRestore = process.env.PG_RESTORE_PATH || "pg_restore";
  const hostDumpVersion = tryExec(hostDump, ["--version"]);
  if (hostDumpVersion !== null && tryExec(hostRestore, ["--version"]) !== null && major(hostDumpVersion) >= server) {
    return { mode: "host", dump: [hostDump], restore: [hostRestore], urlFor: (url) => url };
  }

  const url = new URL(testUrl);
  const container = process.env.JOB_RADAR_DB_CONTAINER || "job-radar-db-1";
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (local && url.port === COMPOSE_DB_PORT && tryExec("docker", ["exec", container, "pg_dump", "--version"]) !== null) {
    const base = ["docker", "exec", "-i", "-e", "PGPASSWORD", container];
    return {
      mode: "docker",
      dump: [...base, "pg_dump"],
      restore: [...base, "pg_restore"],
      urlFor: (original) => {
        const inside = new URL(original);
        inside.hostname = "127.0.0.1";
        inside.port = "5432";
        return inside.toString();
      },
    };
  }
  return null;
}

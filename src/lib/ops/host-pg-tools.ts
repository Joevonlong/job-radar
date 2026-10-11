import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const COMPOSE_TIMEOUT_MS = 15_000;

export interface HostPgTools {
  /** Command prefix for pg_dump (connection flags are appended by runBackup). */
  pgDump: string[];
  /** Command prefix for pg_restore; the archive is fed on stdin. */
  pgRestore: string[];
  /** The URL as the tool sees the server (inside the db container the server is on 127.0.0.1:5432). */
  databaseUrl: string;
}

/**
 * pg_dump / pg_restore for a command run on the host (`pnpm migrate:run`), which has no guarantee of a client matching the
 * server. `PG_DUMP_PATH` / `PG_RESTORE_PATH` win; else the tools of the compose `db` container (like scripts/ops/backup.sh,
 * so no Postgres client is needed); else `pg_dump` / `pg_restore` from the PATH.
 */
export async function resolveHostPgTools(options: { databaseUrl: string; composeDir: string; env?: NodeJS.ProcessEnv }): Promise<HostPgTools> {
  const env = options.env ?? process.env;
  const configuredDump = env.PG_DUMP_PATH?.trim();
  const configuredRestore = env.PG_RESTORE_PATH?.trim();
  if (configuredDump) {
    return { pgDump: [configuredDump], pgRestore: [configuredRestore || "pg_restore"], databaseUrl: options.databaseUrl };
  }
  try {
    const { stdout } = await execFileAsync("docker", ["compose", "ps", "--status", "running", "-q", "db"], { cwd: options.composeDir, timeout: COMPOSE_TIMEOUT_MS });
    const container = stdout.trim().split("\n")[0];
    if (container) {
      const base = ["docker", "exec", "-i", "-e", "PGPASSWORD", container];
      const inside = new URL(options.databaseUrl);
      inside.hostname = "127.0.0.1";
      inside.port = "5432";
      return { pgDump: [...base, "pg_dump"], pgRestore: [...base, "pg_restore"], databaseUrl: inside.toString() };
    }
  } catch {
    // no docker or no compose project here: fall through to the PATH
  }
  return { pgDump: ["pg_dump"], pgRestore: [configuredRestore || "pg_restore"], databaseUrl: options.databaseUrl };
}

// Scripts only: uses child_process and docker. Do not import from web (src/app) or runner code; ESLint enforces this.
import { execFileSync } from "node:child_process";

/** Where the database of an installation runs: a container by name, or the `db` service of a compose project directory. */
export type PsqlTarget = { container: string } | { composeDir: string };

const READ_ONLY = "PGOPTIONS=-c default_transaction_read_only=on";
const PSQL = ["psql", "-U", "jobradar", "-d", "jobradar", "-At", "-c"];

/** The `docker` command line for one query; the session cannot write, whatever the query says. */
export function psqlInvocation(target: PsqlTarget, query: string): { args: string[]; cwd?: string } {
  if ("composeDir" in target) return { args: ["compose", "exec", "-T", "-e", READ_ONLY, "db", ...PSQL, query], cwd: target.composeDir };
  return { args: ["exec", "-e", READ_ONLY, target.container, ...PSQL, query] };
}

/** Run one query in a read-only session; returns psql's unaligned output. */
export function runReadonlyPsql(target: PsqlTarget, query: string): string {
  const { args, cwd } = psqlInvocation(target, query);
  return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 1 << 30, ...(cwd ? { cwd } : {}) });
}

// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * ai_worker_db_url of scripts/ops/lib/ai-worker.sh takes over the DATABASE_URL logic of install-ai-worker.sh as it is.
 * Every case compares it with the install script's original lines (embedded below, APP_DIR as a parameter): same output,
 * exit 0 both. Pure parsing of a throw-away .env; no database is contacted.
 */
const lib = path.resolve(import.meta.dirname, "../../scripts/ops/lib/ai-worker.sh");

// install-ai-worker.sh, the DATABASE_URL block, verbatim; wrapped in a function that takes APP_DIR and the argument
const ORIGINAL = `original_db_url() {
APP_DIR="$1"; DATABASE_URL_ARG="$2"
env_value() { # env_value KEY -> value from .env (first match, quotes stripped), or empty
  local file="$APP_DIR/.env"
  [[ -f "$file" ]] || return 0
  grep -E "^[[:space:]]*$1=" "$file" | head -n1 | sed -E "s/^[[:space:]]*$1=//; s/^['\\"]//; s/['\\"][[:space:]]*\\$//" || true
}
DB_URL="$DATABASE_URL_ARG"
[[ -n "$DB_URL" ]] || DB_URL="\${DATABASE_URL:-}"
[[ -n "$DB_URL" ]] || DB_URL="$(env_value DATABASE_URL)"
if [[ -z "$DB_URL" ]]; then
  db_user="$(env_value POSTGRES_USER)"; db_pass="$(env_value POSTGRES_PASSWORD)"; db_name="$(env_value POSTGRES_DB)"; db_port="$(env_value DB_HOST_PORT)"
  DB_URL="postgres://\${db_user:-jobradar}:\${db_pass:-jobradar}@127.0.0.1:\${db_port:-5433}/\${db_name:-jobradar}"
fi
printf '%s\\n' "$DB_URL"
}`;

let tmp = "";
let main = "";
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-worker-db-url-"));
  main = path.join(tmp, "main");
  fs.mkdirSync(main);
});
afterEach(() => {
  if (tmp && path.basename(tmp).startsWith("ai-worker-db-url-")) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

interface Out {
  status: number | null;
  stdout: string;
  stderr: string;
}
function sh(snippet: string, args: string[], env: Record<string, string>): Out {
  const r = spawnSync("/usr/bin/env", ["-i", "PATH=/usr/bin:/bin", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), "/bin/bash", "-c", snippet, "_", ...args], {
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function compare(dotenv: string | null, arg: string | null, env: Record<string, string> = {}): { now: Out; then: Out } {
  if (dotenv !== null) fs.writeFileSync(path.join(main, ".env"), dotenv);
  const now = sh(`source "${lib}"; if [[ -n "$2" ]]; then ai_worker_db_url "$1" --database-url "$2"; else ai_worker_db_url "$1"; fi`, [main, arg ?? ""], env);
  const then = sh(`${ORIGINAL}\noriginal_db_url "$1" "$2"`, [main, arg ?? ""], env);
  return { now, then };
}

describe("ai_worker_db_url: the same URL as install-ai-worker.sh", () => {
  it.each<[string, string | null, string | null, Record<string, string>, string]>([
    ["the argument wins over everything", "DATABASE_URL=postgres://f:f@h:1/file\n", "postgres://a:a@h:1/arg", { DATABASE_URL: "postgres://e:e@h:1/env" }, "postgres://a:a@h:1/arg"],
    ["then $DATABASE_URL", "DATABASE_URL=postgres://f:f@h:1/file\n", null, { DATABASE_URL: "postgres://e:e@h:1/env" }, "postgres://e:e@h:1/env"],
    ["then DATABASE_URL in .env", "POSTGRES_PASSWORD=pw\nDATABASE_URL=postgres://f:f@h:1/file\n", null, {}, "postgres://f:f@h:1/file"],
    ["then the POSTGRES_* parts", "POSTGRES_USER=u\nPOSTGRES_PASSWORD=pw\nPOSTGRES_DB=d\nDB_HOST_PORT=6000\n", null, {}, "postgres://u:pw@127.0.0.1:6000/d"],
    ["no .env at all", null, null, {}, "postgres://jobradar:jobradar@127.0.0.1:5433/jobradar"],
    ["a .env without any of the keys", "OTHER=1\n# DATABASE_URL=commented\n", null, {}, "postgres://jobradar:jobradar@127.0.0.1:5433/jobradar"],
    ["only the password", "POSTGRES_PASSWORD=s3cret\n", null, {}, "postgres://jobradar:s3cret@127.0.0.1:5433/jobradar"],
    ["only DB_HOST_PORT", "DB_HOST_PORT=6543\n", null, {}, "postgres://jobradar:jobradar@127.0.0.1:6543/jobradar"],
    ["user and database, no password", "POSTGRES_USER=u\nPOSTGRES_DB=d\n", null, {}, "postgres://u:jobradar@127.0.0.1:5433/d"],
    ["single-quoted values", "POSTGRES_USER='u'\nPOSTGRES_PASSWORD='p w'\n", null, {}, "postgres://u:p w@127.0.0.1:5433/jobradar"],
    ["double-quoted values and leading spaces", '  DATABASE_URL="postgres://q:q@h:1/quoted"  \n', null, {}, "postgres://q:q@h:1/quoted"],
    ["the first match counts", "POSTGRES_PASSWORD=first\nPOSTGRES_PASSWORD=second\n", null, {}, "postgres://jobradar:first@127.0.0.1:5433/jobradar"],
  ])("%s", (_label, dotenv, arg, env, expected) => {
    const { now, then } = compare(dotenv, arg, env);
    expect(now.status).toBe(0);
    expect(then.status).toBe(0);
    expect(now.stdout).toBe(then.stdout);
    expect(now.stdout).toBe(`${expected}\n`);
    expect(now.stderr).toBe("");
  });

  it("a password is never written to stderr", () => {
    const { now } = compare("POSTGRES_PASSWORD=very-secret-pw\n", null);
    expect(now.stderr).not.toContain("very-secret-pw");
  });
});

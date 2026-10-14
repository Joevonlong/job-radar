// A stand-in for the host ai-worker, started by the service-manager simulator (tests/ops/sim) from a fake release
// (tests/helpers/fake-release.ts: its src/ai-worker/index.ts imports this file; tsx is loaded, so the TypeScript import
// below works). It does what the switch protocol looks for: takes the worker's instance lock in the database named by
// DATABASE_URL (the definition's) with the real acquireInstanceLock (application_name = job-radar ai-worker pid=… host=…),
// then writes an ai-worker heartbeat now and every second.
//
// The mode comes from the JSON file FAKE_WORKER_CONTROL ({ "<release sha or 'checkout'>": mode, "default": mode }),
// read at start, so one test can give the old and the new release different behaviour:
//   ok                  lock and heartbeats (the default)
//   no-lock             stays alive, never takes the lock (like a worker waiting for it)
//   no-heartbeat        takes the lock, writes no heartbeat
//   ignore-term         like ok, but ignores SIGTERM (only SIGKILL ends it)
//   ignore-term-no-heartbeat
//   crash               exits 1 at once
// Every start appends one JSON line to FAKE_WORKER_RECORD: pid, mode, cwd, argv, the variables the definition sets.
import fs from "node:fs";
import path from "node:path";

import postgres from "postgres";

import { acquireInstanceLock } from "../../../src/lib/db/instance-lock.ts";

const release = path.basename(process.cwd());
let control = {};
try {
  control = JSON.parse(fs.readFileSync(process.env.FAKE_WORKER_CONTROL ?? "", "utf8"));
} catch {
  control = {};
}
const mode = control[release] ?? control.default ?? "ok";
const ENV_KEYS = ["DATABASE_URL", "NODE_OPTIONS", "JOB_RADAR_DEFAULTS_DIR", "JOB_RADAR_CONFIG_DIR", "JOB_RADAR_PROFILE_DIR", "JOB_RADAR_DATA_ROOT", "TSX_TSCONFIG_PATH"];
if (process.env.FAKE_WORKER_RECORD) {
  const env = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k] ?? null]));
  fs.appendFileSync(process.env.FAKE_WORKER_RECORD, `${JSON.stringify({ pid: process.pid, mode, release, cwd: process.cwd(), argv: process.argv, execArgv: process.execArgv, env, at: Date.now() })}\n`);
}
if (mode === "crash") process.exit(1);

const ignoreTerm = mode.startsWith("ignore-term");
const heartbeats = mode !== "no-heartbeat" && mode !== "ignore-term-no-heartbeat";
const url = process.env.DATABASE_URL ?? "";
const keepAlive = setInterval(() => {}, 60_000);
let lock = null;
let sql = null;
let beat = null;

process.on("SIGTERM", () => {
  if (ignoreTerm) return;
  clearInterval(keepAlive);
  if (beat) clearInterval(beat);
  void Promise.allSettled([lock?.release(), sql?.end({ timeout: 2 })]).finally(() => process.exit(0));
});

if (mode !== "no-lock") {
  for (;;) {
    try {
      const result = await acquireInstanceLock(url, { name: "ai-worker", connectTimeoutSeconds: 10 });
      if (result.acquired) {
        lock = result.lock;
        break;
      }
    } catch {
      /* the database is not reachable yet: try again */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (heartbeats) {
    sql = postgres(url, { max: 1, onnotice: () => {} });
    const write = () => sql`insert into runner_heartbeats (process) values ('ai-worker')`.catch(() => {});
    await write();
    beat = setInterval(write, 1000);
  }
}

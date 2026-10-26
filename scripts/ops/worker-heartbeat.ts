/**
 * Database evidence for the host ai-worker tooling (scripts/ops/lib/ai-worker.sh). Thin entry: the queries live in
 * src/lib/db/repos/ai-worker-evidence.ts.
 *
 *   DATABASE_URL=<url> node --import <tsx loader> scripts/ops/worker-heartbeat.ts --now
 *   DATABASE_URL=<url> node --import <tsx loader> scripts/ops/worker-heartbeat.ts --evidence --pid P --host H --since T
 *   DATABASE_URL=<url> node --import <tsx loader> scripts/ops/worker-heartbeat.ts --receipt --pid P --host H --since T
 *   DATABASE_URL=<url> node --import <tsx loader> scripts/ops/worker-heartbeat.ts --holder --pid P --host H
 *
 * The database is only the one named by DATABASE_URL in the environment, which the caller sets explicitly (the URL it
 * writes into the service definition): no .env is read here, and an empty DATABASE_URL exits 1. Prints one JSON line
 * (never the URL).
 *
 *   --holder     compare the current holder with --pid P --host H using the worker's truncated application_name:
 *                {status:"expected"}, {status:"none"} or {status:"other"}; exit 0.
 *                Hidden holder or query failure: {status:"unknown",...}; exit 1. Never takes the lock.
 *   --now        the database clock, UTC with microseconds: {"now":"…"}; exit 0, or 1 when it cannot be read
 *   --evidence   does worker P on host H hold the instance lock, with an ai-worker heartbeat at or after max(T, the lock
 *                connection's start)? exit 0 = found, 2 = not yet, 1 = cannot tell (database unreachable, the holder's
 *                session not visible to this role, bad arguments)
 *   --receipt    evidence plus P's own shipped config report since max(T, the lock connection's start); same exit codes
 */
import { parseArgs } from "node:util";

import { createConnection } from "../../src/lib/db/client";
import { dbNow, workerEvidence, workerReceipt, workerEvidenceSchema, type EvidenceConnection } from "../../src/lib/db/repos/ai-worker-evidence";
import { redact } from "../../src/lib/ops/doctor/helpers";
import { withTimeout } from "../../src/lib/ops/timeout";
import { workerHolder, workerHolderSchema } from "../../src/lib/db/repos/ai-worker-holder";

/** Upper bound for one run (connect, queries); the callers poll again after it. */
const RUN_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_SECONDS = 5;

type Values = Partial<Record<"pid" | "host" | "since", string>>;

interface Mode {
  /** Value options this mode requires (and the only ones it accepts). */
  needs: readonly (keyof Values)[];
  check: (values: Values) => string | null;
  run: (conn: EvidenceConnection, values: Values) => Promise<{ json: unknown; exit: number }>;
}

// One row per mode: a later mode (e.g. a lock-holder probe) is one more row here.
const MODES: Record<"now" | "evidence" | "receipt" | "holder", Mode> = {
  holder: {
    needs: ["pid", "host"],
    check: (v) => {
      if (!/^[1-9][0-9]*$/.test(v.pid ?? "") || !Number.isSafeInteger(Number(v.pid))) return "--pid needs a positive whole number";
      if (!/^\S+$/.test(v.host ?? "")) return "--host needs a host name";
      return null;
    },
    run: async (conn, v) => {
      const result = workerHolderSchema.parse(await workerHolder(conn, { pid: Number(v.pid), host: v.host ?? "" }));
      return { json: result, exit: result.status === "unknown" ? 1 : 0 };
    },
  },
  now: {
    needs: [],
    check: () => null,
    run: async (conn) => ({ json: { now: await dbNow(conn.sql) }, exit: 0 }),
  },
  evidence: {
    needs: ["pid", "host", "since"],
    check: (v) => {
      if (!/^[1-9][0-9]*$/.test(v.pid ?? "")) return `--pid needs a positive whole number, got '${v.pid ?? ""}'`;
      if (!/^\S+$/.test(v.host ?? "")) return "--host needs a host name";
      if (!v.since || Number.isNaN(Date.parse(v.since))) return `--since needs a timestamp (the output of --now), got '${v.since ?? ""}'`;
      return null;
    },
    run: async (conn, v) => {
      const result = workerEvidenceSchema.parse(await workerEvidence(conn, { pid: Number(v.pid), host: v.host ?? "", since: v.since ?? "" }));
      return { json: result, exit: result.status === "found" ? 0 : result.status === "not_yet" ? 2 : 1 };
    },
  },
  receipt: {
    needs: ["pid", "host", "since"],
    check: (v) => MODES.evidence.check(v),
    run: async (conn, v) => {
      const result = workerEvidenceSchema.parse(await workerReceipt(conn, { pid: Number(v.pid), host: v.host ?? "", since: v.since ?? "" }));
      return { json: result, exit: result.status === "found" ? 0 : result.status === "not_yet" ? 2 : 1 };
    },
  },
};

const print = (json: unknown): void => console.log(JSON.stringify(json));
const fail = (detail: string): number => {
  print({ status: "unknown", reason: "error", detail: redact(detail) });
  return 1;
};

async function main(): Promise<number> {
  let parsed: { values: Values & { now?: boolean; evidence?: boolean; receipt?: boolean; holder?: boolean } };
  try {
    parsed = parseArgs({
      options: {
        now: { type: "boolean" },
        evidence: { type: "boolean" },
        receipt: { type: "boolean" },
        holder: { type: "boolean" },
        pid: { type: "string" },
        host: { type: "string" },
        since: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "bad arguments");
  }
  const { values } = parsed;
  const chosen = (Object.keys(MODES) as (keyof typeof MODES)[]).filter((name) => values[name] === true);
  if (chosen.length !== 1) return fail(`give exactly one of ${Object.keys(MODES).map((m) => `--${m}`).join(", ")}`);
  const name = chosen[0] as keyof typeof MODES;
  const mode = MODES[name];
  const extra = (["pid", "host", "since"] as const).filter((key) => values[key] !== undefined && !mode.needs.includes(key));
  if (extra.length > 0) return fail(`--${name} does not take ${extra.map((k) => `--${k}`).join(", ")}`);
  const problem = mode.check(values);
  if (problem) return fail(problem);

  const url = process.env.DATABASE_URL ?? "";
  if (url === "") return fail("DATABASE_URL is empty: the caller must set it explicitly");

  let conn: EvidenceConnection | null = null;
  try {
    conn = createConnection(url, { max: 1, connectTimeoutSeconds: CONNECT_TIMEOUT_SECONDS });
    const { json, exit } = await withTimeout(mode.run(conn, values), RUN_TIMEOUT_MS, `worker-heartbeat --${name}`);
    print(json);
    return exit;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  } finally {
    await conn?.sql.end({ timeout: 2 }).catch(() => {});
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);

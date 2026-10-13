/**
 * Holds the ai-worker instance lock like a running worker does, for tests/integration/worker-heartbeat.test.ts:
 * `DATABASE_URL=<url> RECORD_FILE=<file> node --import tsx tests/fixtures/ops/hold-instance-lock.ts`. Writes one JSON line
 * to RECORD_FILE once it holds the lock ({ pid, acquired, vitest }: whether VITEST reached this process, so the test
 * database guard applies here too), then waits until SIGTERM, releases and exits 0.
 */
import fs from "node:fs";

import { acquireInstanceLock } from "../../../src/lib/db/instance-lock";

const record = process.env.RECORD_FILE ?? "";
const result = await acquireInstanceLock(process.env.DATABASE_URL ?? "", { name: "ai-worker", connectTimeoutSeconds: 10 });
fs.writeFileSync(record, `${JSON.stringify({ pid: process.pid, acquired: result.acquired, vitest: (process.env.VITEST ?? "") !== "" })}\n`);
if (!result.acquired) process.exit(3);
const lock = result.lock;
const keepAlive = setInterval(() => {}, 60_000);
process.on("SIGTERM", () => {
  clearInterval(keepAlive);
  void lock.release().finally(() => process.exit(0));
});

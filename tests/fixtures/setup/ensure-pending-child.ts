/**
 * `ensurePendingSetupFile` in a process of its own, for tests/setup/ensure-pending-setup.test.ts. The lock is the in-process
 * stand-in (`--import tests/fixtures/config/lock-stand-in.mjs`); `JOB_RADAR_TEST_LOCK_PAUSE` stops the commit where the
 * test says. Prints the result as one JSON line.
 */
import { ensurePendingSetupFile } from "../../../src/lib/setup/state";

console.log(JSON.stringify(await ensurePendingSetupFile()));
process.exit(0);

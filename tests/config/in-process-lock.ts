/** The config write lock of the unit tests: same waiting semantics as the database's, without a database. */
import type { ConfigWriteLockProvider, ConfigWriteLockSession } from "@/lib/config/write-lock";

let tail: Promise<void> = Promise.resolve();

export const inProcessConfigWriteLock: ConfigWriteLockProvider = async () => {
  let open = (): void => {};
  const previous = tail;
  tail = new Promise((resolve) => { open = resolve; });
  await previous;
  const lock: ConfigWriteLockSession = { fence: async () => true, release: async () => { open(); } };
  return { acquired: true, lock };
};

/**
 * Tests must never reach a real database. Under Vitest (`VITEST` is set in its workers) a connection is only opened to a
 * disposable test database: the integration suite's `jobradar_test_<id>` (and the copies its tests make from it) or an e2e
 * `jobradar_e2e…` database. Anything else, `jobradar` above all, is refused before a socket is opened.
 */

/** Database names tests may use. */
export const TEST_DATABASE_NAME = /^jobradar_(test|e2e)/;

/** A URL that can never connect (port 1, no such database): what unit tests use to mean "no database". */
export const UNREACHABLE_DATABASE_URL = "postgres://nobody:x@127.0.0.1:1/none";

/** True while running under Vitest. */
export function underVitest(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return (env.VITEST ?? "") !== "";
}

/** Throws under Vitest unless `url` names a test database. The message names the database, never the URL (it may hold a password). */
export function assertTestDatabase(url: string, env: Readonly<Record<string, string | undefined>> = process.env): void {
  if (!underVitest(env)) return;
  let name = "";
  try {
    name = decodeURIComponent(new URL(url).pathname.slice(1));
  } catch {
    name = "";
  }
  if (!TEST_DATABASE_NAME.test(name)) {
    throw new Error(`Refusing to connect to database "${name || "?"}" under Vitest: only jobradar_test* / jobradar_e2e* databases are allowed`);
  }
}

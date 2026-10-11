/**
 * Where the database-backed test runs (`pnpm test:integration`, `pnpm test:e2e`, `pnpm test:e2e:setup`) find a Postgres
 * server. There is deliberately no default address: a default would be the database of a local installation, and a test
 * run has no business there. Without an address the run stops with the commands to start a disposable server.
 */

export const DISPOSABLE_POSTGRES_HELP = [
  "Start a disposable Postgres and point the tests at it (tests never fall back to a local installation's database):",
  "",
  "  docker run --rm -d --name jobradar-test-pg -p 127.0.0.1:55432:5432 -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres postgres:17",
  "  export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres",
  "",
  "The role must be allowed to create databases. Stop the server afterwards with: docker rm -f jobradar-test-pg",
].join("\n");

/**
 * The first non-empty value among `names` in `env` (the address of a server where the role may create databases).
 * Throws with the instructions above when none is set.
 */
export function requireTestAdminDatabaseUrl(env: Readonly<Record<string, string | undefined>>, names: readonly string[], runner: string): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`${runner}: no test database is configured (set ${names.join(" or ")}).\n${DISPOSABLE_POSTGRES_HELP}`);
}

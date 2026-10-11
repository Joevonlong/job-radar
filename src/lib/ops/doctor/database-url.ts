/**
 * The DATABASE_URL host-side tools use. An explicit `DATABASE_URL` wins; otherwise it is built the way compose publishes the
 * `db` service (loopback, `DB_HOST_PORT`, default 5433) from the same `POSTGRES_*` values in `.env` that compose reads, so
 * `pnpm run doctor` works on a machine whose `.env` only holds what compose needs. The password is URL-encoded.
 */
export function resolveHostDatabaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  const explicit = env.DATABASE_URL?.trim();
  if (explicit) return explicit;
  const pick = (name: string, fallback: string): string => {
    const value = env[name]?.trim();
    return value ? value : fallback;
  };
  const user = encodeURIComponent(pick("POSTGRES_USER", "jobradar"));
  const password = encodeURIComponent(pick("POSTGRES_PASSWORD", "jobradar"));
  const database = encodeURIComponent(pick("POSTGRES_DB", "jobradar"));
  const port = pick("DB_HOST_PORT", "5433");
  return `postgres://${user}:${password}@127.0.0.1:${port}/${database}`;
}

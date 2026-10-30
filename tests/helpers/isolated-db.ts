import { randomBytes } from "node:crypto";

import postgres from "postgres";

import { runMigrations } from "../../src/lib/db/migrate";
import { TEST_DATABASE_NAME } from "../../src/lib/db/test-guard";

/**
 * A database of its own for one integration file, owned by a fresh non-superuser role (LOGIN, no pg_read_all_stats),
 * with the migrations applied as that role. Created and dropped through the server of the integration run (the URL
 * global-setup provides, with its admin role); every name starts with `jobradar_test_` (the prefix test-guard.ts
 * accepts), and anything else is refused before a statement is sent. Roles are server-wide: they carry the database's
 * name and are dropped with it.
 */
export interface IsolatedDb {
  name: string;
  /** The owner role's URL for this database. */
  url: string;
  /** One more LOGIN role (non-superuser) that may connect to this database; returns its URL. */
  addRole(suffix: string): Promise<string>;
  drop(): Promise<void>;
}

const NAME = /^[a-z0-9_]+$/;
/** The port of a local installation's database (compose.yaml DB_HOST_PORT default): never a test server. */
const INSTALLATION_PORT = "5433";

/** Throws unless `name` is a name this helper may create (exported for its unit test). */
export function checkedName(name: string): string {
  if (!TEST_DATABASE_NAME.test(name) || !name.startsWith("jobradar_test_") || !NAME.test(name) || name.length > 63) {
    throw new Error(`isolated-db: refusing the name "${name}" (it must start with jobradar_test_, [a-z0-9_] only, at most 63 characters)`);
  }
  return name;
}

function withDatabase(url: string, database: string, user?: { name: string; password: string }): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}

/** `serverUrl`: any URL of the integration run's server whose role may create databases and roles (e.g. inject("testDatabaseUrl")). */
export async function createIsolatedDb(serverUrl: string, label: string): Promise<IsolatedDb> {
  if (new URL(serverUrl).port === INSTALLATION_PORT) throw new Error(`isolated-db: refusing port ${INSTALLATION_PORT} (a local installation's database)`);
  const name = checkedName(`jobradar_test_${label}_${process.pid}_${randomBytes(3).toString("hex")}`);
  const roles: string[] = [];
  const admin = postgres(withDatabase(serverUrl, "postgres"), { max: 1, onnotice: () => {} });

  const createRole = async (role: string): Promise<{ name: string; password: string }> => {
    checkedName(role);
    const password = randomBytes(12).toString("hex");
    await admin.unsafe(`create role "${role}" login nosuperuser nocreatedb nocreaterole noinherit password '${password}'`);
    roles.push(role);
    return { name: role, password };
  };

  try {
    const owner = await createRole(`${name}_o`);
    await admin.unsafe(`create database "${name}" owner "${owner.name}"`);
    const url = withDatabase(serverUrl, name, owner);
    await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 }, url });
    return {
      name,
      url,
      async addRole(suffix: string) {
        const role = await createRole(`${name}_${suffix}`);
        await admin.unsafe(`grant connect on database "${name}" to "${role.name}"`);
        return withDatabase(serverUrl, name, role);
      },
      async drop() {
        try {
          await admin.unsafe(`drop database if exists "${name}" with (force)`);
          for (const role of roles.splice(0)) await admin.unsafe(`drop role if exists "${role}"`);
        } finally {
          await admin.end({ timeout: 5 });
        }
      },
    };
  } catch (error) {
    await admin.unsafe(`drop database if exists "${name}" with (force)`).catch(() => {});
    for (const role of roles) await admin.unsafe(`drop role if exists "${role}"`).catch(() => {});
    await admin.end({ timeout: 5 });
    throw error;
  }
}

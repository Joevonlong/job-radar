import { sql } from "drizzle-orm";

import type { Db } from "./client";

export interface AppliedMigrations {
  /** Rows in drizzle's bookkeeping table; 0 when the table does not exist (nothing was ever migrated). */
  count: number;
  /** `created_at` of the newest row: the `when` of the newest journal entry that was applied (ms since epoch). */
  latestAt: number | null;
}

/**
 * What drizzle's migrator has applied (`drizzle.__drizzle_migrations`; its `created_at` is the journal's `when`).
 * A database that was never migrated has no such table: that is `{ count: 0, latestAt: null }`, not an error.
 */
export async function readAppliedMigrations(db: Db): Promise<AppliedMigrations> {
  const exists = await db.execute<{ present: boolean }>(sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`);
  if (exists[0]?.present !== true) return { count: 0, latestAt: null };
  const rows = await db.execute<{ count: number; latest_at: string | null }>(
    sql`select count(*)::int as count, max(created_at)::text as latest_at from drizzle.__drizzle_migrations`,
  );
  const row = rows[0];
  return { count: row?.count ?? 0, latestAt: row?.latest_at == null ? null : Number(row.latest_at) };
}

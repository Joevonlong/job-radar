import { sql } from "drizzle-orm";

import type { Db } from "../client";

export interface TableCount {
  /** `schema.table`, e.g. `public.jobs`. */
  table: string;
  rows: number;
}

/** Exact row count of every user table (all schemas but the system ones), sorted by name. Used to verify a restore. */
export async function countTableRows(db: Db): Promise<TableCount[]> {
  const rows = await db.execute<{ tbl: string; rows: string }>(sql`
    select table_schema || '.' || table_name as tbl,
           (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text as rows
    from information_schema.tables
    where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')
    order by 1`);
  return rows.map((row) => ({ table: row.tbl, rows: Number(row.rows) }));
}

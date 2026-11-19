import { sql } from "drizzle-orm";

import type { Db } from "@/lib/db";

export type SchemaProbeTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Drop the change-log triggers on a table before simulating an older schema in a rolled-back transaction. */
export async function dropAgentChangeTriggers(tx: SchemaProbeTransaction, table: string): Promise<void> {
  const triggers = await tx.execute<{ name: string }>(sql`
    select tgname as name from pg_catalog.pg_trigger
    where tgrelid = pg_catalog.to_regclass(pg_catalog.format('public.%I', ${table}::text))
      and not tgisinternal and starts_with(tgname, 'agent_change_')`);
  for (const { name } of triggers) {
    await tx.execute(sql`drop trigger ${sql.identifier(name)} on public.${sql.identifier(table)}`);
  }
}

import postgres from "postgres";

/** Clear application data and recreate the singleton change log identity. The schema must already be migrated. */
export async function resetDatabase(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const tables = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`;
    if (tables.length === 0) return;
    const list = tables.map((t) => `"${t.table_name}"`).join(", ");
    await sql.unsafe(`truncate table ${list} restart identity cascade`);
    if (tables.some(({ table_name }) => table_name === "agent_change_log")) {
      await sql`select public.agent_changes_reset()`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

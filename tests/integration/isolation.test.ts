import { describe, expect, inject, it } from "vitest";
import postgres from "postgres";

import { runMigrations } from "@/lib/db/migrate";

const url = inject("testDatabaseUrl");

/** Guards the isolation mechanism of setup.ts: a file never sees what an earlier file left behind. */
describe("integration database isolation", () => {
  it("starts every file with all application tables empty", async () => {
    process.env.DATABASE_URL = url;
    await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const tables = await sql<{ table_name: string }[]>`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`;
      expect(tables.length).toBeGreaterThan(20);
      const filled: string[] = [];
      for (const { table_name } of tables) {
        const [row] = await sql.unsafe(`select count(*)::int as n from "${table_name}"`);
        if (row && row.n > 0) filled.push(`${table_name}=${row.n}`);
      }
      expect(filled).toEqual([]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("leaves data behind that the next file cannot see (written here, removed by the reset after this file)", async () => {
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await sql`insert into companies (name, name_norm) values ('Acme GmbH', 'acme')`;
      expect(await sql`select 1 from companies where name_norm = 'acme'`).toHaveLength(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});


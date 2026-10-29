import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";

import { closeDb, getDb } from "@/lib/db";
import { createReadOnlyDb } from "@/lib/db/read-only-client";

// The web pool and the read-only MCP pool run the job search; JIT compilation costs more than those queries.
// Runner and AI worker (no NEXT_RUNTIME) keep the server default.
const originalRuntime = process.env.NEXT_RUNTIME;

/** The session's JIT setting and where it came from ("client" = set when the connection was opened). */
async function jit(db = getDb()): Promise<{ setting: string; source: string }> {
  const rows = await db.execute<{ setting: string; source: string }>(sql`select setting, source from pg_settings where name = 'jit'`);
  return { setting: rows[0]!.setting, source: rows[0]!.source };
}

beforeAll(() => { process.env.DATABASE_URL = inject("testDatabaseUrl"); });
afterEach(async () => {
  await closeDb();
  if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = originalRuntime;
});
afterAll(closeDb);

describe("database session settings", () => {
  it("turns JIT off on the shared pool of the web process", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    await closeDb();
    expect(await jit()).toEqual({ setting: "off", source: "client" });
  });

  it("keeps the server default on the shared pool outside the web process", async () => {
    delete process.env.NEXT_RUNTIME;
    await closeDb();
    expect((await jit()).source).not.toBe("client");
  });

  it("turns JIT off on the read-only pool and keeps it read-only", async () => {
    const readOnly = createReadOnlyDb({ url: inject("testDatabaseUrl") });
    try {
      expect(await jit(readOnly.db)).toEqual({ setting: "off", source: "client" });
      const rows = await readOnly.db.execute<{ default_transaction_read_only: string }>(sql`show default_transaction_read_only`);
      expect(rows[0]!.default_transaction_read_only).toBe("on");
    } finally {
      await readOnly.close();
    }
  });
});

/**
 * `scripts/ops/deploy.sh` runs `pnpm ops:drain` (and the doctor) with the new code before it migrates, so the code can name a
 * control request kind that the database enum does not have yet. Counting open requests must then match nothing, not throw.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { closeDb, countOpenControlRequests, getDb, insertControlRequest } from "@/lib/db";
import type { ControlRequestKind } from "@/lib/db/repos/control-requests";
import { runMigrations } from "@/lib/db/migrate";

const url = inject("testDatabaseUrl");
const notInTheEnumYet = "kind_added_by_a_later_migration" as ControlRequestKind;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

beforeEach(async () => {
  await getDb().execute(sql`truncate table control_requests restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
});

describe("countOpenControlRequests with a kind the database does not know yet", () => {
  it("counts zero instead of failing with an invalid enum value", async () => {
    await expect(countOpenControlRequests(getDb(), [notInTheEnumYet])).resolves.toEqual({ pending: 0, running: 0, oldestPendingAt: null });
  });

  it("still counts the kinds it does know, next to an unknown one", async () => {
    await insertControlRequest(getDb(), { kind: "run_ai" });
    const stats = await countOpenControlRequests(getDb(), [notInTheEnumYet, "run_ai"]);
    expect(stats.pending).toBe(1);
    expect(stats.running).toBe(0);
    expect(stats.oldestPendingAt).toBeInstanceOf(Date);
  });
});

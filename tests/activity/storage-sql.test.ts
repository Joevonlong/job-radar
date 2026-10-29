// @vitest-environment node
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import type { SQL } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { activeRootCondition, activityTablesReady, reconcileActivitySpans, resetActivityTablesCache } from "@/lib/db/repos/activity";
import { activitySpans } from "@/lib/db/schema";

afterEach(() => resetActivityTablesCache());

it("renders reconciliation with a real table and a correlated alias, with parameterized liveness", async () => {
  const execute = vi.fn<(statement: SQL) => Promise<never[]>>(async () => []);
  const db = { execute } as unknown as Db;
  expect(await reconcileActivitySpans(db, { staleAfterSeconds: 89, startupGraceSeconds: 47 })).toBe(0);
  const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
  expect(query.sql).toContain('from "activity_spans" as "activity_root"');
  expect(query.sql).toContain('"activity_root"."id" = "activity_spans"."root_id"');
  expect(query.sql).not.toContain('from "activity_root" where');
  expect(query.params).toEqual([89, 47]);
  expect(query.sql).toContain("cr.payload ->> 'cycleId'");
  expect(query.sql).toContain('"activity_root"."cycle_id"::text');
  expect(query.sql).toContain("now()");
});

it("does not cache a negative readiness result, and caches true for the process", async () => {
  const execute = vi.fn().mockResolvedValueOnce([{ ok: false }]).mockResolvedValueOnce([{ ok: true }]);
  const db = { execute } as unknown as Db;
  expect(await activityTablesReady(db)).toBe(false);
  expect(await activityTablesReady(db)).toBe(true);
  expect(await activityTablesReady(db)).toBe(true);
  expect(execute).toHaveBeenCalledTimes(2);
});

it("keeps outer qualifiers in SELECT projections as well as WHERE predicates", () => {
  const db = drizzle.mock();
  const condition = activeRootCondition(activitySpans, { staleAfterSeconds: 89, startupGraceSeconds: 47 });
  const projection = db.select({ active: condition }).from(activitySpans).toSQL().sql;
  const filter = db.select().from(activitySpans).where(condition).toSQL().sql;
  for (const query of [projection, filter]) {
    expect(query).toContain('hb.process = "activity_spans"."process"');
    expect(query).toContain('startup.started_at > "activity_spans"."started_at"');
    expect(query).toContain('(newer.started_at, newer.id) > ("activity_spans"."started_at", "activity_spans"."id")');
  }
});

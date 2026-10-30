import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { closeDb, getDb, schema, writeHeartbeat } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";

const url = inject("testDatabaseUrl");

interface HealthJson {
  db: string;
  lastHeartbeatAt: string | null;
  heartbeatAgeSeconds: number | null;
}

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
  // The database is shared by all integration files in a run: start from no heartbeats.
  await getDb().delete(schema.runnerHeartbeats);
});

afterAll(async () => {
  await closeDb();
});

describe("GET /api/health", () => {
  it("reports db ok with no heartbeat before the runner has written one", async () => {
    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ db: "ok", lastHeartbeatAt: null, heartbeatAgeSeconds: null });
  });

  it("reports a fresh heartbeat", async () => {
    await writeHeartbeat(getDb(), "runner");
    const { GET } = await import("@/app/api/health/route");
    const body = (await (await GET()).json()) as HealthJson;
    expect(body.db).toBe("ok");
    expect(body.lastHeartbeatAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.heartbeatAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(body.heartbeatAgeSeconds).toBeLessThan(10);
  });

  it("returns 503 without leaking the connection string when the database is unreachable", async () => {
    await closeDb();
    process.env.DATABASE_URL = "postgres://secretuser:secretpass@127.0.0.1:1/nodb";
    try {
      const { GET } = await import("@/app/api/health/route");
      const response = await GET();
      const text = await response.text();
      expect(response.status).toBe(503);
      expect(JSON.parse(text)).toEqual({ db: "error", lastHeartbeatAt: null, heartbeatAgeSeconds: null });
      expect(text).not.toContain("secret");
    } finally {
      await closeDb();
      process.env.DATABASE_URL = url;
    }
  });
});

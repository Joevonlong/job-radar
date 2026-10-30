import { spawnSync } from "node:child_process";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { closeDb, getDb, writeHeartbeat } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { checkRunnerHealth } from "@/lib/ops/runner-health";

const url = inject("testDatabaseUrl");
const root = path.resolve(import.meta.dirname, "../..");
const tsx = path.join(root, "node_modules/.bin/tsx");

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

beforeEach(async () => {
  await getDb().execute(sql`truncate table runner_heartbeats restart identity`);
});

afterAll(async () => {
  await closeDb();
});

/** Run the container's healthcheck entry point exactly as compose does (`node dist/healthcheck.mjs`, here via tsx). */
function runHealthcheck(env: Record<string, string>): { status: number | null; json: Record<string, unknown> } {
  const result = spawnSync(tsx, ["src/runner/healthcheck.ts"], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  const line = result.stdout.trim().split("\n").pop() ?? "{}";
  return { status: result.status, json: JSON.parse(line) as Record<string, unknown> };
}

describe("runner healthcheck", () => {
  it("is unhealthy with no heartbeat, healthy with a fresh one, and unhealthy again once it is older than the limit", async () => {
    expect(await checkRunnerHealth(getDb(), { maxAgeSeconds: 120 })).toMatchObject({ healthy: false, reason: "no heartbeat" });

    await writeHeartbeat(getDb(), "runner");
    expect(await checkRunnerHealth(getDb(), { maxAgeSeconds: 120 })).toMatchObject({ healthy: true, reason: "ok" });

    // the heartbeat times out: the runner stopped writing 10 minutes ago
    await getDb().execute(sql`update runner_heartbeats set at = now() - interval '10 minutes'`);
    expect(await checkRunnerHealth(getDb(), { maxAgeSeconds: 120 })).toMatchObject({ healthy: false, reason: "heartbeat too old" });
    // ...and a fake clock reaches the same verdict without waiting
    await writeHeartbeat(getDb(), "runner");
    const later = () => new Date(Date.now() + 5 * 60 * 1000);
    expect(await checkRunnerHealth(getDb(), { maxAgeSeconds: 120, now: later })).toMatchObject({ healthy: false });
  });

  it("the healthcheck process exits 0 on a fresh heartbeat and 1 once it has timed out", async () => {
    await writeHeartbeat(getDb(), "runner");
    const fresh = runHealthcheck({ DATABASE_URL: url, RUNNER_HEALTH_MAX_AGE_SECONDS: "120" });
    expect(fresh.status).toBe(0);
    expect(fresh.json).toMatchObject({ healthy: true, reason: "ok" });

    await getDb().execute(sql`update runner_heartbeats set at = now() - interval '3 minutes'`);
    const stale = runHealthcheck({ DATABASE_URL: url, RUNNER_HEALTH_MAX_AGE_SECONDS: "120" });
    expect(stale.status).toBe(1);
    expect(stale.json).toMatchObject({ healthy: false, reason: "heartbeat too old" });

    // a longer limit tolerates the same heartbeat
    expect(runHealthcheck({ DATABASE_URL: url, RUNNER_HEALTH_MAX_AGE_SECONDS: "600" }).status).toBe(0);
  }, 90_000);

  it("exits 1 without leaking the connection string when the database is unreachable", () => {
    const result = runHealthcheck({ DATABASE_URL: "postgres://secretuser:secretpass@127.0.0.1:1/nodb" });
    expect(result.status).toBe(1);
    expect(JSON.stringify(result.json)).not.toContain("secret");
    expect(result.json.healthy).toBe(false);
  }, 60_000);
});

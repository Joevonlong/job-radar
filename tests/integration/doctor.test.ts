import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { resetConfigCache } from "@/lib/config";
import { closeDb, getDb, readAppliedMigrations, writeHeartbeat } from "@/lib/db";
import { createCycle, finishCycle } from "@/lib/db/repos/cycles";
import { ALL_CHECKS, runDoctor, type CommandOutcome, type DoctorContext } from "@/lib/ops/doctor";
import { readJournal } from "@/lib/db/migration-journal";
import { createRealContext } from "@/lib/ops/doctor/probes";
import { probeDeliveries } from "@/lib/ops/doctor/deliveries";
import { deliveryCheck } from "@/lib/ops/doctor/checks/deliveries";
import { finishRunWithDeliveries, resetDeliveryTablesCache } from "@/lib/db/repos/deliveries";
import { createRun } from "@/lib/db/repos/runs";

const url = inject("testDatabaseUrl");
const migrationsDir = path.resolve(import.meta.dirname, "../../drizzle");

beforeAll(() => {
  process.env.DATABASE_URL = url;
  resetConfigCache();
});

afterAll(async () => {
  await closeDb();
});

/** The real context (config from the shipped YAML, real database probes); Docker, CLIs and the network are faked. */
async function context(): Promise<DoctorContext> {
  const real = await createRealContext({ ...process.env, DATABASE_URL: url, MIGRATIONS_DIR: migrationsDir, RUNNER_BACKUP_DIR: "/nonexistent-doctor-backups" });
  const none: CommandOutcome = { kind: "missing" };
  // a configured install (the test's empty user directory would otherwise read the shipped, pending setup.yaml)
  const setup = async () => ({ pending: false, state: { completed_at: "2026-10-01T08:00:00.000Z", completed_by: "wizard" as const, steps: {} }, error: null, source: "user" as const, path: null });
  return { ...real, probes: { ...real.probes, setup, run: async () => none, http: async () => ({ ok: false, status: null, body: null, error: "ECONNREFUSED" }) } };
}

describe("doctor against a real database", () => {
  it("only reports ledger size, leaving every receipt and summary unchanged", async () => {
    resetDeliveryTablesCache();
    const db = getDb();
    const channelId = "doctor-delivery-test";
    await db.execute(sql`insert into channels (id, family, kind) values (${channelId}, 'linkedin', 'paid')`);
    const runId = (await createRun(db, { channelId })).id;
    await finishRunWithDeliveries(db, {
      runId, channelId, ledger: "client", windowCutoffAt: null, expected: { delivered: 1 }, run: { status: "succeeded" },
      items: [{ ordinal: 0, batch: 1, disposition: "no_identity", externalId: null, flags: [], confirmed: false,
        payloadHash: "doctor-receipt-hash", payloadBytes: 100, payloadJson: { text: "private source" }, payloadText: null,
        receivedAt: new Date("2026-01-01T00:00:00Z") }],
    });
    const snapshot = async () => ({
      items: await db.execute(sql`select id, payload_hash, to_jsonb(delivery_items) as content from delivery_items order by id`),
      // Summaries have run_id rather than id, and no payload_hash; hash their complete content instead.
      summaries: await db.execute(sql`select run_id as id, md5(to_jsonb(run_deliveries)::text) as payload_hash, to_jsonb(run_deliveries) as content from run_deliveries order by run_id`),
    });
    const before = await snapshot();
    expect(before.items).toHaveLength(1);
    expect(before.summaries).toHaveLength(1);
    for (const [warnBytes, status] of [[101, "ok"], [100, "ok"], [99, "warn"]] as const) {
      const ctx = await context();
      ctx.probes.deliveries = () => probeDeliveries({ db, loadConfig: () => ({ retention: { days: 1, warn_bytes: warnBytes } }) });
      const report = await runDoctor(ctx, [deliveryCheck]);
      expect(report.checks[0]?.status).toBe(status);
      expect(await snapshot()).toEqual(before);
    }
  });
  it("migrations: what the journal ships equals what the migrator applied", async () => {
    const [expected, applied] = [await readJournal(migrationsDir), await readAppliedMigrations(getDb())];
    expect(expected?.count).toBeGreaterThan(0);
    expect(applied).toEqual({ count: expected?.count, latestAt: expected?.latestAt });
  });

  it("db.connect and db.migrations are ok, and fail when a migration is missing", async () => {
    const ctx = await context();
    const ids = new Map((await runDoctor(ctx, ALL_CHECKS.filter((c) => c.id === "db.connect" || c.id === "db.migrations"))).checks.map((c) => [c.id, c]));
    expect(ids.get("db.connect")?.status).toBe("ok");
    expect(ids.get("db.migrations")?.status).toBe("ok");

    const last = await getDb().execute<{ id: number }>(sql`select id from drizzle.__drizzle_migrations order by created_at desc limit 1`);
    const removed = await getDb().execute(sql`delete from drizzle.__drizzle_migrations where id = ${last[0]?.id ?? -1} returning hash, created_at`);
    try {
      const behind = (await runDoctor(await context(), ALL_CHECKS.filter((c) => c.id === "db.migrations"))).checks[0];
      expect(behind?.status).toBe("fail");
      expect(behind?.detail).toContain("缺 1 个迁移");
    } finally {
      const row = removed[0] as { hash: string; created_at: string } | undefined;
      if (row) await getDb().execute(sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${row.hash}, ${row.created_at})`);
    }
  });

  it("runner and ai-worker heartbeats, the latest cycle and the AI queue come from the real tables", async () => {
    const pick = ["runner.heartbeat", "aiworker.heartbeat", "cycle.last", "ai.backlog", "channels.each", "budget.all"];
    const checks = ALL_CHECKS.filter((c) => pick.includes(c.id));

    const empty = new Map((await runDoctor(await context(), checks)).checks.map((c) => [c.id, c]));
    expect(empty.get("runner.heartbeat")).toMatchObject({ status: "fail", detail: "runner 从来没有写过心跳" });
    expect(empty.get("aiworker.heartbeat")?.status).toBe("fail");
    expect(empty.get("cycle.last")).toMatchObject({ status: "warn", detail: "还没有跑过任何轮次" });
    expect(empty.get("ai.backlog")?.detail).toContain("0 条等待");
    expect(empty.get("budget.paid")?.status).toBe("ok");

    await writeHeartbeat(getDb(), "runner");
    await writeHeartbeat(getDb(), "ai-worker");
    const cycle = await createCycle(getDb(), { kind: "manual" });
    await finishCycle(getDb(), cycle.id, { status: "succeeded" });
    const healthy = new Map((await runDoctor(await context(), checks)).checks.map((c) => [c.id, c]));
    expect(healthy.get("runner.heartbeat")?.status).toBe("ok");
    expect(healthy.get("aiworker.heartbeat")?.status).toBe("ok");
    expect(healthy.get("cycle.last")).toMatchObject({ status: "ok", detail: expect.stringContaining("manual") });
  });

  it("the whole report runs without a docker, a network or a real backup directory, and never throws", async () => {
    const report = await runDoctor(await context());
    expect(report.checks.length).toBeGreaterThan(25);
    expect(report.checks.find((c) => c.id === "docker.daemon")?.status).toBe("fail");
    expect(report.checks.find((c) => c.id === "backup.recent")?.status).toBe("fail");
    expect(report.checks.find((c) => c.id === "db.connect")?.status).toBe("ok");
    expect(report.exitCode).toBe(2);
    expect(JSON.stringify(report)).not.toContain(url);
  });
});

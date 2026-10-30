import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { resetConfigCache } from "@/lib/config";
import { SHIPPED_CONFIG_PROCESSES, shippedConfigId, shippedConfigReportSchema } from "@/lib/config/shipped-id";
import { closeDb, getDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { readShippedConfigReports, reportShippedConfig } from "@/lib/db/repos/runtime-state";
import { ALL_CHECKS, runDoctor, type CommandOutcome, type DoctorContext } from "@/lib/ops/doctor";
import { createRealContext } from "@/lib/ops/doctor/probes";
import { createShippedConfigReporter } from "@/lib/ops/shipped-config";

const url = inject("testDatabaseUrl");
const migrationsDir = path.resolve(import.meta.dirname, "../../drizzle");
let dir = "";

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  resetConfigCache();
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipped-config-it-"));
  fs.writeFileSync(path.join(dir, "schedule.yaml"), "timezone: Europe/Berlin\n");
});

beforeEach(async () => {
  await getDb().execute(sql`delete from runtime_state where key like 'shipped_config:%'`);
});

afterAll(async () => {
  await closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const dbNow = async (): Promise<Date> => {
  const rows = await getDb().execute<{ now: Date | string }>(sql`select now() as now`);
  return new Date(rows[0]?.now ?? Number.NaN);
};

describe("shipped config reports in runtime_state", () => {
  it("each of the three processes writes a report that passes the schema, timed by the database clock", async () => {
    const before = await dbNow();
    for (const [index, process] of SHIPPED_CONFIG_PROCESSES.entries()) {
      const reporter = createShippedConfigReporter({ process, db: getDb, log: () => undefined, dir: () => dir, pid: 100 + index, instance: `host-${process}`, timeoutMs: () => 20_000 });
      expect(await reporter.report()).toBe(true);
    }
    const reports = await readShippedConfigReports(getDb());
    const id = await shippedConfigId(dir);
    for (const [index, process] of SHIPPED_CONFIG_PROCESSES.entries()) {
      const row = reports[process];
      expect(row?.report).toMatchObject({ id, dir, instance: `host-${process}`, pid: 100 + index });
      expect(shippedConfigReportSchema.safeParse(row?.report).success).toBe(true);
      expect(row?.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    }
    const raw = await getDb().execute<{ key: string }>(sql`select key from runtime_state where key like 'shipped_config:%' order by key`);
    expect(raw.map((r) => r.key)).toEqual(["shipped_config:ai-worker", "shipped_config:runner", "shipped_config:web"]);
  });

  it("a refresh moves updated_at forward and replaces the report", async () => {
    const report = { id: "a".repeat(64), dir, instance: "h", pid: 1, startedAt: new Date().toISOString() };
    await reportShippedConfig(getDb(), "runner", report);
    await getDb().execute(sql`update runtime_state set updated_at = now() - interval '1 hour' where key = 'shipped_config:runner'`);
    const old = (await readShippedConfigReports(getDb())).runner?.updatedAt;
    await reportShippedConfig(getDb(), "runner", { ...report, id: "b".repeat(64) });
    const fresh = (await readShippedConfigReports(getDb())).runner;
    expect(fresh?.report.id).toBe("b".repeat(64));
    expect(fresh?.updatedAt.getTime()).toBeGreaterThan((old?.getTime() ?? 0) + 3_000_000);
  });

  it("reads bad data and unknown processes as no report", async () => {
    await getDb().execute(sql`insert into runtime_state (key, value) values
      ('shipped_config:web', '{"id":"nope"}'::jsonb),
      ('shipped_config:runner', '"text"'::jsonb),
      ('shipped_config:other', ${JSON.stringify({ id: "a".repeat(64), dir: "/x", instance: "h", pid: 1, startedAt: "2026-10-07T12:00:00.000Z" })}::jsonb)`);
    expect(await readShippedConfigReports(getDb())).toEqual({ web: null, runner: null, "ai-worker": null });
  });

  it("refuses to write a report that does not pass the schema", async () => {
    await expect(reportShippedConfig(getDb(), "web", { id: "short", dir, instance: "h", pid: 1, startedAt: new Date().toISOString() })).rejects.toThrow();
    expect((await readShippedConfigReports(getDb())).web).toBeNull();
  });
});

describe("doctor config.shipped against a real database", () => {
  async function context(): Promise<DoctorContext> {
    const real = await createRealContext({ ...process.env, DATABASE_URL: url, MIGRATIONS_DIR: migrationsDir, RUNNER_BACKUP_DIR: "/nonexistent-doctor-backups" });
    const none: CommandOutcome = { kind: "missing" };
    return { ...real, probes: { ...real.probes, run: async () => none } };
  }

  it("reads the reports through the real probe: missing reports and no Docker are warnings", async () => {
    const result = (await runDoctor(await context(), ALL_CHECKS.filter((c) => c.id === "config.shipped"))).checks[0];
    expect(result?.id).toBe("config.shipped");
    expect(result?.status).toBe("warn");
  });
});

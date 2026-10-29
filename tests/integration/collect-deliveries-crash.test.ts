import { spawn } from "node:child_process";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";

import { deliveryCountsSchema } from "@/lib/channels/delivery";
import { closeDb, getDb, schema } from "@/lib/db";
import { createConnection } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { failOrphanedCycles } from "@/lib/db/repos/cycles";

import type { TempConfig } from "../config/helpers";
import { auditConfig, UNIT_USD } from "./fixtures/collect-deliveries-helpers";

const url = inject("testDatabaseUrl");
const root = path.resolve(import.meta.dirname, "../..");
let temp: TempConfig;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});
beforeEach(async () => {
  temp = auditConfig();
  await getDb().execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels restart identity cascade`);
});
afterEach(() => temp.cleanup());
afterAll(() => closeDb());

function start(mode: "checkpoint" | "before-commit" | "after-commit" | "paid-checkpoint") {
  const child = spawn(process.execPath, ["--import", "tsx", "tests/integration/fixtures/collect-deliveries-child.ts", mode], {
    cwd: root,
    env: {
      PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      HOME: temp.root, NODE_ENV: "test", VITEST: "true", DATABASE_URL: url,
      JOB_RADAR_DEFAULTS_DIR: temp.defaultsDir, JOB_RADAR_CONFIG_DIR: temp.configDir,
      JOB_RADAR_PROFILE_DIR: temp.profileDir, JOB_RADAR_CONFIG_POLL_MS: "0",
      DB_CONNECT_TIMEOUT_SECONDS: "30",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const finished = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
  return { child, output: () => output, finished: finished.finally(() => clearTimeout(timer)) };
}

async function kill(processRun: ReturnType<typeof start>) {
  expect(processRun.child.kill("SIGKILL"), processRun.output()).toBe(true);
  expect(await processRun.finished, processRun.output()).toEqual({ code: null, signal: "SIGKILL" });
}

async function cleanup(processRun: ReturnType<typeof start>) {
  if (processRun.child.exitCode === null && processRun.child.signalCode === null) processRun.child.kill("SIGKILL");
  await processRun.finished;
}

it.each(["before", "after"] as const)("recovers real collect and paid-client receipts killed %s checkpoint commit", async (boundary) => {
  const blocker = createConnection(url, { max: 1 });
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holding = boundary === "before" ? blocker.db.transaction(async (tx) => {
    await tx.execute(sql`lock table delivery_items in access exclusive mode`);
    ready.resolve();
    await release.promise;
  }) : Promise.resolve();
  if (boundary === "before") await ready.promise;
  const processRun = start("paid-checkpoint");
  try {
    await vi.waitFor(async () => {
      expect(processRun.child.exitCode, processRun.output()).toBeNull();
      expect(processRun.output()).toContain("paid-batch-captured");
      if (boundary === "before") {
        // The real client's receipt has reached the checkpoint SQL, but this lock prevents commit.
        const waiting = await getDb().execute(sql`select pid from pg_locks
          where relation = 'delivery_items'::regclass and not granted`);
        expect(waiting.length).toBeGreaterThan(0);
      } else expect(await getDb().select().from(schema.deliveryItems)).toHaveLength(1);
    }, { timeout: 15_000, interval: 25 });
    await kill(processRun);
  } finally {
    await cleanup(processRun);
    release.resolve();
    await holding;
    await blocker.sql.end();
  }
  const [run] = await getDb().select().from(schema.runs);
  expect(run).toMatchObject({ channelId: "linkedin-monid", status: "running", usageUnits: 0, fetched: 0, finishedAt: null });
  const items = await getDb().select().from(schema.deliveryItems);
  expect(items).toHaveLength(boundary === "before" ? 0 : 1);
  if (boundary === "after") expect(items[0]).toMatchObject({
    runId: run!.id, ordinal: 0, batch: 1, disposition: "received_uncommitted", rawPostingId: null,
    payloadJson: { id: "paid-checkpoint", body: "verbatim output from fake Monid HTTP" },
  });
  expect(await getDb().select().from(schema.runDeliveries)).toHaveLength(0);
  expect(await getDb().select().from(schema.rawPostings)).toHaveLength(0);
  expect(await failOrphanedCycles(getDb(), "paid client process was killed")).toEqual({ cycles: 1, runs: 1 });
  expect((await getDb().select().from(schema.runs))[0]).toMatchObject({ status: "failed", usageUnits: 0, fetched: 0 });
  expect(await getDb().select().from(schema.deliveryItems)).toEqual(items);
}, 30_000);

it("keeps the first committed collect checkpoint after SIGKILL and orphan recovery", async () => {
  const processRun = start("checkpoint");
  try {
    // Receipt registration is synchronous; only the SQL row proves its background checkpoint committed.
    await vi.waitFor(async () => {
      expect(processRun.child.exitCode, processRun.output()).toBeNull();
      const rows = await getDb().select().from(schema.deliveryItems);
      expect(rows, processRun.output()).toHaveLength(1);
    }, { timeout: 15_000, interval: 50 });
    await kill(processRun);
    const [run] = await getDb().select().from(schema.runs);
    expect(run).toMatchObject({ status: "running", usageUnits: 0, fetched: 0, finishedAt: null });
    const [item] = await getDb().select().from(schema.deliveryItems);
    expect(item).toMatchObject({
      runId: run!.id, ordinal: 0, batch: 1, disposition: "received_uncommitted", rawPostingId: null,
      payloadJson: { id: "checkpoint", body: "keep this entire received payload" }, payloadText: null,
    });
    expect(await getDb().select().from(schema.runDeliveries)).toHaveLength(0);
    expect(await getDb().select().from(schema.rawPostings)).toHaveLength(0);
    expect(await failOrphanedCycles(getDb(), "test process was killed")).toEqual({ cycles: 1, runs: 1 });
    const [recovered] = await getDb().select().from(schema.runs).where(eq(schema.runs.id, run!.id));
    expect(recovered).toMatchObject({ status: "failed", error: "test process was killed", usageUnits: 0 });
    expect(recovered?.finishedAt).toBeInstanceOf(Date);
    expect(await getDb().select().from(schema.deliveryItems)).toEqual([item]);
  } finally {
    await cleanup(processRun);
  }
}, 30_000);

it("rolls back the entire final transaction when killed inside its beforeCommit hook", async () => {
  const processRun = start("before-commit");
  try {
    await vi.waitFor(() => {
      expect(processRun.child.exitCode, processRun.output()).toBeNull();
      expect(processRun.output()).toContain("inside-final-transaction");
    }, { timeout: 15_000 });
    await kill(processRun);
    const runs = await getDb().select().from(schema.runs);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "running", usageUnits: 0, fetched: 0, newCount: 0, finishedAt: null });
    expect(Number(runs[0]?.cost)).toBe(0);
    expect(await getDb().select().from(schema.runDeliveries)).toHaveLength(0);
    expect(await getDb().select().from(schema.rawPostings)).toHaveLength(0);
    const items = await getDb().select().from(schema.deliveryItems).orderBy(schema.deliveryItems.ordinal);
    expect(items.map((item) => [item.runId, item.ordinal, item.disposition, item.rawPostingId])).toEqual([
      [runs[0]!.id, 0, "received_uncommitted", null], [runs[0]!.id, 1, "received_uncommitted", null],
    ]);
    expect(items.map((item) => item.payloadJson)).toEqual([{ id: "committed", body: "stored raw payload" }, { error: "provider refused" }]);
    expect(await failOrphanedCycles(getDb(), "rolled back after process death")).toEqual({ cycles: 1, runs: 1 });
    expect((await getDb().select().from(schema.runs))[0]?.status).toBe("failed");
    expect(await getDb().select().from(schema.deliveryItems).orderBy(schema.deliveryItems.ordinal)).toEqual(items);
  } finally {
    await cleanup(processRun);
  }
}, 30_000);

it("keeps usage, final dispositions and reconciliation together when killed just after commit", async () => {
  const processRun = start("after-commit");
  try {
    await vi.waitFor(() => {
      expect(processRun.child.exitCode, processRun.output()).toBeNull();
      expect(processRun.output()).toContain("final-commit-complete");
    }, { timeout: 15_000 });
    await kill(processRun);
    const runs = await getDb().select().from(schema.runs);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run).toMatchObject({ status: "succeeded", usageUnits: 5, fetched: 1, newCount: 1 });
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(Number(run.cost)).toBeCloseTo(5 * UNIT_USD, 6);
    const summaries = await getDb().select().from(schema.runDeliveries);
    expect(summaries).toHaveLength(1);
    const summary = summaries[0]!;
    expect(summary).toMatchObject({ runId: run.id, ledger: "client", delivered: 2, billedUnits: run.usageUnits, distinctIds: 1 });
    const counts = deliveryCountsSchema.parse(summary.countsJson);
    expect(counts.dispositions).toEqual({ stored: 1, provider_error: 1 });
    expect(counts.mismatch ?? []).toEqual([]);
    expect(Object.values(counts.dispositions).reduce((sum, count) => sum + count, 0)).toBe(summary.delivered);
    const items = await getDb().select().from(schema.deliveryItems).orderBy(schema.deliveryItems.ordinal);
    const raw = await getDb().select().from(schema.rawPostings);
    expect(raw).toHaveLength(run.fetched);
    expect(raw[0]).toMatchObject({ runId: run.id, externalId: "committed", payloadJson: { id: "committed", body: "stored raw payload" } });
    expect(items).toHaveLength(summary.delivered);
    expect(items[0]).toMatchObject({ runId: run.id, ordinal: 0, disposition: "stored", rawPostingId: raw[0]!.id, payloadJson: null, payloadText: null, payloadHash: raw[0]!.payloadHash });
    expect(items[1]).toMatchObject({ runId: run.id, ordinal: 1, disposition: "provider_error", rawPostingId: null, payloadJson: { error: "provider refused" } });
  } finally {
    await cleanup(processRun);
  }
}, 30_000);

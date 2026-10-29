import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { closeDb, getDb } from "@/lib/db/client";
import { deliveryPayloadBytes, deliveryTablesReady, finishRunWithDeliveries, insertDeliveryCheckpoint, pruneDeliveryItems, resetDeliveryTablesCache } from "@/lib/db/repos/deliveries";
import { createRun } from "@/lib/db/repos/runs";
import { createDeliveryPruner } from "@/runner/delivery-prune";

const url = inject("testDatabaseUrl");
const now = new Date("2026-10-20T12:00:00Z");
const channelId = "prune-test";
let runId: number;

beforeAll(() => { process.env.DATABASE_URL = url; });
beforeEach(async () => {
  resetDeliveryTablesCache();
  await getDb().execute(sql`insert into channels (id, family, kind) values (${channelId}, 'linkedin', 'paid')`);
  runId = (await createRun(getDb(), { channelId })).id;
  await finishRunWithDeliveries(getDb(), { runId, channelId, ledger: "client", items: [], windowCutoffAt: null, expected: { delivered: 0 }, run: { status: "succeeded" } });
});
afterAll(async () => { resetDeliveryTablesCache(); await closeDb(); });

async function receive(ordinal: number, receivedAt: Date) {
  await insertDeliveryCheckpoint(getDb(), { runId, channelId, rows: [{ ordinal, batch: 1, payloadHash: `hash-${ordinal}`, payloadBytes: 10, payloadJson: { text: "retained" }, payloadText: null, flags: [], receivedAt }] });
}

function pruner(warnBytes: number) {
  const db = getDb();
  return createDeliveryPruner({
    now: () => now,
    loadConfig: () => ({ retention: { days: 1, warn_bytes: warnBytes }, prune: { every_minutes: 60, batch_size: 1, statement_timeout_ms: 1000 } }),
    tablesReady: () => deliveryTablesReady(db), payloadBytes: () => deliveryPayloadBytes(db),
    prune: (input) => pruneDeliveryItems(db, input), log: () => {},
  });
}

async function remaining() {
  return (await getDb().execute<{ ordinal: number }>(sql`select ordinal from delivery_items order by ordinal`)).map((row) => row.ordinal);
}

describe("runner delivery pruning", () => {
  it("deletes only rows strictly older than one day and keeps run summaries", async () => {
    await receive(0, new Date("2026-10-19T11:59:59Z"));
    await receive(1, new Date("2026-10-19T12:00:00Z"));
    await receive(2, now);
    await pruner(1000).tick();
    expect(await remaining()).toEqual([1, 2]);
    expect(await getDb().execute(sql`select run_id from run_deliveries where run_id = ${runId}`)).toHaveLength(1);
  });

  it("prunes early above the threshold, retaining fresh receipts and accepting new ones", async () => {
    const service = pruner(1);
    await service.tick();
    await receive(0, new Date("2026-10-18T12:00:00Z"));
    await receive(1, now);
    await service.afterCollect();
    expect(await remaining()).toEqual([1]);
    await receive(2, now);
    await service.afterCollect();
    expect(await remaining()).toEqual([1, 2]);
    expect(await deliveryPayloadBytes(getDb())).toBe(20);
    expect(await getDb().execute(sql`select run_id from run_deliveries where run_id = ${runId}`)).toHaveLength(1);
  });
});

import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { deliveryCountsSchema, type DeliveryCheckpointRow, type DeliveryFinal } from "@/lib/channels/delivery";
import { closeDb, getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import {
  deliveryPayloadBytes,
  deliveryTablesReady,
  finishRunWithDeliveries,
  insertDeliveryCheckpoint,
  pruneDeliveryItems,
  resetDeliveryTablesCache,
} from "@/lib/db/repos/deliveries";
import { hashPayload, listRawPostingsForChannel, upsertRawPostings } from "@/lib/db/repos/raw-postings";
import { createRun, getRun } from "@/lib/db/repos/runs";

const url = inject("testDatabaseUrl");
const CHANNEL = "delivery-probe";
const RECEIVED_AT = new Date("2026-10-20T12:00:00Z");
const CUTOFF = new Date("2026-10-19T12:00:00Z");
let runId: number;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

beforeEach(async () => {
  // The shared integration setup resets all tables, including the new ledger tables.
  resetDeliveryTablesCache();
  await getDb().execute(sql`insert into channels (id, family, kind) values (${CHANNEL}, 'linkedin', 'paid')`);
  runId = (await createRun(getDb(), { channelId: CHANNEL })).id;
});

afterAll(async () => {
  resetDeliveryTablesCache();
  await closeDb();
});

function item(ordinal: number, overrides: Partial<DeliveryFinal> = {}): DeliveryFinal {
  const payload = { id: `item-${ordinal}`, text: "source payload" };
  return {
    ordinal, batch: 1, disposition: "discarded_on_failure", flags: [], externalId: null,
    payloadHash: hashPayload(payload), payloadBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
    payloadJson: payload, payloadText: null, receivedAt: RECEIVED_AT, confirmed: false,
    ...overrides,
  };
}

function checkpoint(entry: DeliveryFinal): DeliveryCheckpointRow {
  return {
    ordinal: entry.ordinal, batch: entry.batch, payloadHash: entry.payloadHash, payloadBytes: entry.payloadBytes,
    payloadJson: entry.payloadJson, payloadText: entry.payloadText, flags: entry.flags, receivedAt: entry.receivedAt,
  };
}

function inputFor(items: readonly DeliveryFinal[]): Parameters<typeof finishRunWithDeliveries>[1] {
  return {
    runId, channelId: CHANNEL, ledger: "client", items, windowCutoffAt: CUTOFF,
    expected: { delivered: items.length },
    run: { status: "succeeded", fetched: 0, newCount: 0, cost: 0, usageUnits: 0 },
  };
}

type ItemRow = {
  ordinal: number;
  batch: number;
  channel_id: string;
  external_id: string | null;
  disposition: string;
  flags: string[];
  payload_hash: string;
  payload_bytes: number;
  payload_json: unknown | null;
  payload_text: string | null;
  raw_posting_id: string | null;
  received_at: string;
};

function itemRows() {
  return getDb().execute<ItemRow>(sql`
    select ordinal, batch, channel_id, external_id, disposition, flags, payload_hash, payload_bytes,
      payload_json, payload_text, raw_posting_id::text, received_at::text
    from delivery_items where run_id = ${runId} order by ordinal`);
}

type SummaryRow = {
  run_id: string;
  channel_id: string;
  ledger: string;
  delivered: number;
  billed_units: number;
  distinct_ids: number;
  counts_json: unknown;
  window_cutoff_at: string | null;
};

function summaries() {
  return getDb().execute<SummaryRow>(sql`
    select run_id::text, channel_id, ledger, delivered, billed_units, distinct_ids, counts_json,
      window_cutoff_at::text
    from run_deliveries where run_id = ${runId}`);
}

async function checkpointRows(items: readonly DeliveryFinal[]) {
  await insertDeliveryCheckpoint(getDb(), { runId, channelId: CHANNEL, rows: items.map(checkpoint) });
}

/** Confirmed final rows may omit payloads already retained by a checkpoint. */
async function mixedDelivery() {
  const text = "unparsed provider body";
  const received = [
    item(0, { disposition: "stored", externalId: "same-id", confirmed: true }),
    item(1, { disposition: "no_identity", flags: ["unidentified"], confirmed: true }),
    item(2, {
      disposition: "unparsed_response", flags: ["body_truncated"], confirmed: true,
      payloadJson: null, payloadText: text,
      payloadHash: createHash("sha256").update(text).digest("hex"), payloadBytes: Buffer.byteLength(text, "utf8"),
    }),
    item(3, { disposition: "duplicate_in_run", externalId: "same-id" }),
  ];
  await checkpointRows(received.slice(0, 3));
  const input = inputFor(received.map((entry) => entry.confirmed ? { ...entry, payloadJson: null, payloadText: null } : entry));
  input.raw = { items: [{ externalId: "same-id", url: null, payload: received[0]!.payloadJson }] };
  input.run = { status: "partial", fetched: 1, newCount: 1, usageUnits: 5, cost: 0.25, error: "some records rejected", errorCode: "parse", interrupted: true };
  return { input, received };
}

describe("delivery storage", () => {
  it("finds both migrated tables and exposes a resettable readiness cache", async () => {
    expect(await deliveryTablesReady(getDb())).toBe(true);
    resetDeliveryTablesCache();
    expect(await deliveryTablesReady(getDb())).toBe(true);
  });

  it("inserts checkpoints idempotently with their original payloads and timestamps", async () => {
    const received = [item(0), item(1, { batch: 2 })];
    await checkpointRows(received);
    const before = await itemRows();
    await checkpointRows(received);
    const after = await itemRows();
    expect(after).toEqual(before);
    expect(after).toHaveLength(2);
    for (const [index, row] of after.entries()) {
      expect(row).toMatchObject({
        ordinal: index, batch: index + 1, channel_id: CHANNEL, disposition: "received_uncommitted",
        payload_json: received[index]!.payloadJson, payload_hash: received[index]!.payloadHash,
        payload_bytes: received[index]!.payloadBytes, payload_text: null, raw_posting_id: null,
      });
      expect(new Date(row.received_at)).toEqual(RECEIVED_AT);
    }
    expect(await summaries()).toHaveLength(0);
    expect((await getRun(getDb(), runId))?.status).toBe("running");
  });

  it("commits raw postings, final dispositions, finish fields and summary together", async () => {
    const { input, received } = await mixedDelivery();
    const result = await finishRunWithDeliveries(getDb(), input);
    expect(result.upsert).toEqual({ inserted: 1, changed: 0, unchanged: 0 });
    expect(result.mismatch).toEqual([]);
    expect(deliveryCountsSchema.safeParse(result.counts).success).toBe(true);
    const raw = await listRawPostingsForChannel(getDb(), CHANNEL);
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ runId, externalId: "same-id", payloadJson: received[0]!.payloadJson });
    const rows = await itemRows();
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ disposition: "stored", raw_posting_id: String(raw[0]!.id), payload_json: null, payload_text: null });
    expect(rows[1]).toMatchObject({ disposition: "no_identity", payload_json: received[1]!.payloadJson, payload_text: null, flags: ["unidentified"], raw_posting_id: null });
    expect(rows[2]).toMatchObject({ disposition: "unparsed_response", payload_text: received[2]!.payloadText, payload_json: null, flags: ["body_truncated"], raw_posting_id: null });
    expect(rows[3]).toMatchObject({ disposition: "duplicate_in_run", payload_json: received[3]!.payloadJson, external_id: "same-id", raw_posting_id: null });
    for (const [index, row] of rows.entries()) {
      expect(row.payload_hash).toBe(received[index]!.payloadHash);
      expect(new Date(row.received_at)).toEqual(RECEIVED_AT);
    }
    expect(await getRun(getDb(), runId)).toMatchObject({
      status: "partial", fetched: 1, newCount: 1, usageUnits: 5, cost: 0.25,
      error: "some records rejected", errorCode: "parse", interrupted: true, finishedAt: expect.any(Date),
    });
    const [summary] = await summaries();
    expect(summary).toMatchObject({ run_id: String(runId), channel_id: CHANNEL, ledger: "client", delivered: 4, billed_units: 5, distinct_ids: 1 });
    expect(new Date(summary!.window_cutoff_at!)).toEqual(CUTOFF);
    const counts = deliveryCountsSchema.parse(summary!.counts_json);
    expect(counts.dispositions).toMatchObject({ stored: 1, no_identity: 1, unparsed_response: 1, duplicate_in_run: 1 });
    expect(counts.flags).toMatchObject({ unidentified: 1, body_truncated: 1 });
    expect(counts.mismatch ?? []).toEqual([]);
    expect(result.counts).toEqual(counts);
    expect(Object.values(counts.dispositions).reduce((sum: number, count) => sum + Number(count), 0)).toBe(summary!.delivered);
    expect(summary!.billed_units).toBe((await getRun(getDb(), runId))?.usageUnits);
  });

  it.each([false, true])("derives an omitted run insert count inside the transaction (posting exists: %s)", async (exists) => {
    const entry = item(0, { disposition: "stored", externalId: "one" });
    const raw = { externalId: "one", url: null, payload: entry.payloadJson };
    if (exists) await upsertRawPostings(getDb(), { channelId: CHANNEL, runId: null, items: [raw] });
    const input = inputFor([entry]);
    input.raw = { items: [raw] };
    input.run = { status: "succeeded", fetched: 1, usageUnits: 1 };
    const result = await finishRunWithDeliveries(getDb(), input);
    expect(result.upsert.inserted).toBe(exists ? 0 : 1);
    expect((await getRun(getDb(), runId))?.newCount).toBe(result.upsert.inserted);
    expect(result.mismatch).toEqual([]);
  });

  it("leaves counts and summary values unchanged when final input is submitted twice", async () => {
    const { input } = await mixedDelivery();
    await finishRunWithDeliveries(getDb(), input);
    const beforeItems = await itemRows();
    const beforeSummary = await summaries();
    const beforeRaw = await listRawPostingsForChannel(getDb(), CHANNEL);
    const result = await finishRunWithDeliveries(getDb(), input);
    expect(await itemRows()).toEqual(beforeItems);
    expect(await summaries()).toEqual(beforeSummary);
    expect(await listRawPostingsForChannel(getDb(), CHANNEL)).toHaveLength(beforeRaw.length);
    expect(result.upsert).toEqual({ inserted: 0, changed: 0, unchanged: 1 });
    expect(result.mismatch).toEqual([]);
  });

  it("rolls back every final write when the pre-commit hook throws", async () => {
    await upsertRawPostings(getDb(), { channelId: CHANNEL, runId, items: [{ externalId: "existing", url: null, payload: { version: 1 } }], fetchedAt: RECEIVED_AT });
    const rawBefore = await listRawPostingsForChannel(getDb(), CHANNEL);
    const runBefore = await getRun(getDb(), runId);
    const received = [
      item(0, { disposition: "stored", externalId: "existing", payloadJson: { version: 2 }, payloadHash: hashPayload({ version: 2 }), payloadBytes: 13, confirmed: true }),
      item(1, { disposition: "stored", externalId: "new", confirmed: true }),
    ];
    await checkpointRows(received);
    const checkpointBefore = await itemRows();
    const failure = new Error("abort before final commit");
    let hookCalled = false;
    const input = inputFor(received);
    input.raw = { items: received.map((entry) => ({ externalId: entry.externalId!, url: null, payload: entry.payloadJson })) };
    input.run = { status: "succeeded", fetched: 2, newCount: 1, usageUnits: 7, cost: 0.5 };
    input.beforeCommit = async () => {
      hookCalled = true;
      // Separate pool queries must still see the committed checkpoint state, even after every final write.
      expect(await getRun(getDb(), runId)).toEqual(runBefore);
      expect(await itemRows()).toEqual(checkpointBefore);
      expect(await summaries()).toHaveLength(0);
      expect(await listRawPostingsForChannel(getDb(), CHANNEL)).toEqual(rawBefore);
      throw failure;
    };
    await expect(finishRunWithDeliveries(getDb(), input)).rejects.toBe(failure);
    expect(hookCalled).toBe(true);
    expect(await getRun(getDb(), runId)).toEqual(runBefore);
    expect((await getRun(getDb(), runId))?.status).toBe("running");
    expect(await summaries()).toHaveLength(0);
    expect(await listRawPostingsForChannel(getDb(), CHANNEL)).toEqual(rawBefore);
    expect(await itemRows()).toEqual(checkpointBefore);
    expect((await itemRows()).map((row) => row.disposition)).toEqual(["received_uncommitted", "received_uncommitted"]);
  });

  it("records an expected delivery mismatch without throwing or losing the actual counts", async () => {
    const input = inputFor([item(0)]);
    input.expected.delivered = 2;
    const result = await finishRunWithDeliveries(getDb(), input);
    expect(result.mismatch.length).toBeGreaterThan(0);
    expect(result.mismatch.every((code: string) => typeof code === "string" && code.length > 0)).toBe(true);
    const [summary] = await summaries();
    expect(summary?.delivered).toBe(1);
    const counts = deliveryCountsSchema.parse(summary!.counts_json);
    expect(counts.dispositions.discarded_on_failure).toBe(1);
    expect(counts.mismatch).toEqual(result.mismatch);
    expect((await getRun(getDb(), runId))?.status).toBe("succeeded");
  });

  it("writes a zero-delivery summary for a run stopped before receiving items", async () => {
    const input = inputFor([]);
    input.ledger = "collect";
    input.windowCutoffAt = null;
    input.run = { status: "skipped", errorCode: "budget_exceeded" };
    const result = await finishRunWithDeliveries(getDb(), input);
    expect(result.upsert).toEqual({ inserted: 0, changed: 0, unchanged: 0 });
    expect(result.mismatch).toEqual([]);
    expect(await itemRows()).toHaveLength(0);
    const rows = await summaries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ledger: "collect", delivered: 0, billed_units: 0, distinct_ids: 0, window_cutoff_at: null });
    const counts = deliveryCountsSchema.parse(rows[0]!.counts_json);
    expect(Object.values(counts.dispositions).reduce((sum: number, count) => sum + Number(count), 0)).toBe(0);
    expect((await getRun(getDb(), runId))?.status).toBe("skipped");
  });

  it("counts payload bytes only while a JSON or text payload is retained", async () => {
    const { input, received } = await mixedDelivery();
    expect(await deliveryPayloadBytes(getDb())).toBe(received.slice(0, 3).reduce((sum, entry) => sum + entry.payloadBytes, 0));
    await finishRunWithDeliveries(getDb(), input);
    // Stored payloads are cleared; a previously unconfirmed JSON payload has now been inserted.
    expect(await deliveryPayloadBytes(getDb())).toBe(received.slice(1).reduce((sum, entry) => sum + entry.payloadBytes, 0));
  });

  it("prunes all expired items in batches, retaining the summary and the cutoff boundary", async () => {
    const old = new Date("2026-10-18T12:00:00Z");
    const received = [item(0, { receivedAt: old }), item(1, { receivedAt: old }), item(2, { receivedAt: old }), item(3, { receivedAt: CUTOFF }), item(4)];
    await checkpointRows(received);
    await finishRunWithDeliveries(getDb(), inputFor(received.map((entry) => ({ ...entry, confirmed: true }))));
    const summaryBefore = await summaries();
    expect(await pruneDeliveryItems(getDb(), { olderThan: CUTOFF, batchSize: 1, statementTimeoutMs: 1000 })).toBe(3);
    expect((await itemRows()).map((row) => row.ordinal)).toEqual([3, 4]);
    expect(await summaries()).toEqual(summaryBefore);
    expect(await deliveryPayloadBytes(getDb())).toBe(received[3]!.payloadBytes + received[4]!.payloadBytes);
    expect(await pruneDeliveryItems(getDb(), { olderThan: CUTOFF, batchSize: 1, statementTimeoutMs: 1000 })).toBe(0);
  });

  it("keeps the existing raw upsert count contract for new, unchanged and changed postings", async () => {
    const input = { channelId: CHANNEL, runId, fetchedAt: RECEIVED_AT, items: [{ externalId: "raw-probe", url: null, payload: { version: 1 } }] };
    expect(await upsertRawPostings(getDb(), input)).toEqual({ inserted: 1, changed: 0, unchanged: 0 });
    expect(await upsertRawPostings(getDb(), input)).toEqual({ inserted: 0, changed: 0, unchanged: 1 });
    expect(await upsertRawPostings(getDb(), { ...input, items: [{ ...input.items[0]!, payload: { version: 2 } }] })).toEqual({ inserted: 0, changed: 1, unchanged: 0 });
  });
});

import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  DELIVERY_DISPOSITIONS, DELIVERY_FLAGS, deliveryCountsSchema,
  type DeliveryCheckpointRow, type DeliveryCounts, type DeliveryFinal,
} from "@/lib/channels/delivery";

import type { Db } from "../client";
import type { Executor } from "../executor";
import { deliveryItems, runDeliveries } from "../schema";
import { setLocalWriteTimeout } from "../write-timeout";
import { upsertRawPostingsWithExecutor, type RawUpsertItem, type RawUpsertResult } from "./raw-postings";
import { finishRunWithExecutor, type FinishRunFields } from "./runs";

export type { FinishRunFields } from "./runs";

let tablesSeen = false;

/** Older installations skip the audit until both tables exist; only a successful check is cached. */
export async function deliveryTablesReady(db: Executor): Promise<boolean> {
  if (tablesSeen) return true;
  const [row] = await db.execute<{ summary: string | null; items: string | null }>(sql`
    select to_regclass('run_deliveries')::text as summary, to_regclass('delivery_items')::text as items
  `);
  tablesSeen = row?.summary != null && row.items != null;
  return tablesSeen;
}

/** Forget readiness between test databases. */
export function resetDeliveryTablesCache(): void {
  tablesSeen = false;
}

const dispositionSchema = z.enum(DELIVERY_DISPOSITIONS);
const flagsSchema = z.array(z.enum(DELIVERY_FLAGS));
const CHUNK = 500;

/** Save receipts independently of the final run transaction; repeated checkpoints preserve the first receipt. */
export async function insertDeliveryCheckpoint(db: Db, input: {
  runId: number; channelId: string; rows: readonly DeliveryCheckpointRow[];
  writeTimeoutMs?: number;
}): Promise<void> {
  if (input.rows.length === 0) return;
  await db.transaction(async (tx) => {
    await setLocalWriteTimeout(tx, input.writeTimeoutMs);
    for (let offset = 0; offset < input.rows.length; offset += CHUNK) {
      await tx.insert(deliveryItems).values(input.rows.slice(offset, offset + CHUNK).map((row) => ({
        ...row, flags: flagsSchema.parse(row.flags), runId: input.runId, channelId: input.channelId,
        disposition: dispositionSchema.parse("received_uncommitted"),
      }))).onConflictDoNothing({ target: [deliveryItems.runId, deliveryItems.ordinal] });
    }
  });
}

/** Atomically store postings, finalize receipts, close the run and record reconciliation evidence. */
export async function finishRunWithDeliveries(db: Db, input: {
  runId: number;
  channelId: string;
  ledger: "client" | "collect";
  raw?: { items: readonly RawUpsertItem[] };
  items: readonly DeliveryFinal[];
  windowCutoffAt: Date | null;
  expected: { delivered: number };
  /** An omitted newCount is derived from this transaction's raw upsert. */
  run: FinishRunFields;
  writeTimeoutMs?: number;
  /** Test hook awaited after all writes, immediately before commit. */
  beforeCommit?: () => Promise<void>;
}): Promise<{ upsert: RawUpsertResult; counts: DeliveryCounts; mismatch: string[] }> {
  return db.transaction(async (tx) => {
    await setLocalWriteTimeout(tx, input.writeTimeoutMs);
    const { result: upsert, ids } = await upsertRawPostingsWithExecutor(tx, {
      channelId: input.channelId, runId: input.runId, items: input.raw?.items ?? [],
    });
    const counts: DeliveryCounts = { dispositions: {}, flags: {} };
    for (let offset = 0; offset < input.items.length; offset += CHUNK) {
      const rows = input.items.slice(offset, offset + CHUNK).map((entry) => {
        const disposition = dispositionSchema.parse(entry.disposition);
        const flags = flagsSchema.parse(entry.flags);
        counts.dispositions[disposition] = (counts.dispositions[disposition] ?? 0) + 1;
        for (const flag of new Set(flags)) counts.flags[flag] = (counts.flags[flag] ?? 0) + 1;
        return {
          runId: input.runId, channelId: input.channelId, ordinal: entry.ordinal, batch: entry.batch,
          externalId: entry.externalId, disposition, flags, payloadHash: entry.payloadHash, payloadBytes: entry.payloadBytes,
          payloadJson: disposition === "stored" ? null : entry.payloadJson,
          payloadText: disposition === "stored" ? null : entry.payloadText,
          rawPostingId: disposition === "stored" && entry.externalId !== null ? ids.get(entry.externalId) ?? null : null,
          receivedAt: entry.receivedAt,
        };
      });
      await tx.insert(deliveryItems).values(rows).onConflictDoUpdate({
        target: [deliveryItems.runId, deliveryItems.ordinal],
        set: {
          disposition: sql`excluded.disposition`,
          flags: sql`excluded.flags`,
          externalId: sql`excluded.external_id`,
          rawPostingId: sql`excluded.raw_posting_id`,
          payloadJson: sql`case when excluded.disposition = 'stored' then null else coalesce(excluded.payload_json, ${deliveryItems.payloadJson}) end`,
          payloadText: sql`case when excluded.disposition = 'stored' then null else coalesce(excluded.payload_text, ${deliveryItems.payloadText}) end`,
        },
      });
    }

    // Collect cannot know the insert count until this transaction has upserted its raw postings.
    const run = await finishRunWithExecutor(tx, input.runId, { ...input.run, newCount: input.run.newCount ?? upsert.inserted });
    const delivered = input.items.length;
    const billedUnits = input.run.usageUnits ?? 0;
    const mismatch: string[] = [];
    if (delivered !== input.expected.delivered || Object.values(counts.dispositions).reduce((sum, count) => sum + count, 0) !== delivered) {
      mismatch.push("delivered_sum");
    }
    if (billedUnits !== run?.usageUnits) mismatch.push("billed_units");
    if ((counts.dispositions.stored ?? 0) !== upsert.inserted + upsert.changed + upsert.unchanged) mismatch.push("stored_count");
    if (mismatch.length > 0) counts.mismatch = mismatch;
    const validated = deliveryCountsSchema.parse(counts);
    const summary = {
      runId: input.runId, channelId: input.channelId, ledger: z.enum(["client", "collect"]).parse(input.ledger),
      delivered, billedUnits,
      distinctIds: new Set(input.items.flatMap((entry) => entry.externalId === null ? [] : [entry.externalId])).size,
      countsJson: validated, windowCutoffAt: input.windowCutoffAt, recordedAt: sql`now()`,
    };
    await tx.insert(runDeliveries).values(summary).onConflictDoUpdate({ target: runDeliveries.runId, set: summary });
    await input.beforeCommit?.();
    return { upsert, counts: validated, mismatch };
  });
}

/** Prune only expired receipts in short, timed transactions; run summaries remain indefinitely. */
export async function pruneDeliveryItems(db: Db, input: {
  olderThan: Date; batchSize: number; statementTimeoutMs: number;
}): Promise<number> {
  const batchSize = z.number().int().positive().parse(input.batchSize);
  const timeoutMs = z.number().int().positive().parse(input.statementTimeoutMs);
  let total = 0;
  for (;;) {
    const deleted = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', ${`${timeoutMs}ms`}, true)`);
      const rows = await tx.execute<{ id: string | number }>(sql`
        delete from delivery_items where id in (
          select id from delivery_items where received_at < ${input.olderThan.toISOString()}::timestamptz
          order by received_at, id limit ${batchSize}
        ) returning id
      `);
      return rows.length;
    });
    total += deleted;
    if (deleted < batchSize) return total;
  }
}

/** Logical payload bytes still retained, excluding receipts whose stored payload was cleared. */
export async function deliveryPayloadBytes(db: Executor): Promise<number> {
  const [row] = await db.execute<{ bytes: string | number }>(sql`
    select coalesce(sum(payload_bytes), 0) as bytes from delivery_items
    where payload_json is not null or payload_text is not null
  `);
  return Number(row?.bytes ?? 0);
}

import { createDeliveryLedger, type DeliveryFinal } from "@/lib/channels/delivery";
import { rawPostingInputSchema, type ChannelLogger, type RawPostingInput } from "@/lib/channels/types";
import type { DeliveryAuditConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { finishRunWithDeliveries, insertDeliveryCheckpoint, type FinishRunFields } from "@/lib/db/repos/deliveries";
import { finishRun } from "@/lib/db/repos/runs";

function ordinalOf(record: unknown): number | undefined {
  if (typeof record !== "object" || record === null || !("deliveryOrdinal" in record)) return undefined;
  const ordinal = record.deliveryOrdinal;
  return typeof ordinal === "number" && Number.isInteger(ordinal) && ordinal >= 0 ? ordinal : undefined;
}

function payloadOf(record: unknown): unknown {
  return typeof record === "object" && record !== null && "payload" in record ? record.payload : record;
}

/** Checkpoints and the final transaction for one in-scope collect attempt. */
export function createCollectDeliveries(options: {
  db: Db;
  runId: number;
  channelId: string;
  config: DeliveryAuditConfig;
  logger: ChannelLogger;
  now: () => Date;
}) {
  const { db, runId, channelId, logger } = options;
  const timeoutMs = options.config.checkpoint.write_timeout_ms;
  const context = { channel: channelId, runId };
  const ledger = createDeliveryLedger({
    persist: (rows) => insertDeliveryCheckpoint(db, { runId, channelId, rows, writeTimeoutMs: timeoutMs }),
    onPersistError: () => logger.warn("delivery checkpoint could not be written", context),
    now: options.now,
  });
  let source: "client" | "collect" | null = null;
  const valid: RawPostingInput[] = [];
  const invalid = new Set<number>();

  const finalItems = (storeFailed: boolean): DeliveryFinal[] => ledger.finalize({
    stored: new Map(valid.flatMap((record) => record.deliveryOrdinal === undefined ? [] : [[record.deliveryOrdinal, record.externalId]])),
    invalid,
    storeFailed,
  });

  const write = async (run: FinishRunFields, store: boolean, storeFailed = false) => {
    const cutoff = ledger.windowCutoff();
    const result = await finishRunWithDeliveries(db, {
      runId, channelId,
      ledger: source ?? (ledger.receivedCount() === 0 ? "collect" : "client"),
      ...(store ? { raw: { items: valid.map((record) => ({ externalId: record.externalId, url: record.url, payload: record.payload })) } } : {}),
      items: finalItems(storeFailed),
      windowCutoffAt: cutoff === null ? null : new Date(cutoff),
      expected: { delivered: ledger.receivedCount() },
      run, writeTimeoutMs: timeoutMs,
    });
    if (result.mismatch.length > 0) logger.warn("delivery reconciliation mismatch", { ...context, mismatch: result.mismatch });
    return result.upsert;
  };

  return {
    ledger,
    /** Register missing receipts before parsing, so rejected shapes retain their ordinal and payload. */
    validate(records: readonly unknown[]): RawPostingInput[] {
      source = ledger.receivedCount() === 0 ? "collect" : "client";
      const ordinals = records.map(ordinalOf);
      const missing = records.flatMap((record, index) => ordinals[index] === undefined ? [{ index, payload: payloadOf(record) }] : []);
      if (missing.length > 0) {
        const assigned = ledger.received({ batch: ledger.beginBatch(), items: missing.map((record) => record.payload) });
        for (const [index, record] of missing.entries()) ordinals[record.index] = assigned[index];
      }
      for (const [index, record] of records.entries()) {
        const ordinal = ordinals[index];
        const parsed = rawPostingInputSchema.safeParse(record);
        if (parsed.success) valid.push({ ...parsed.data, deliveryOrdinal: ordinal });
        else if (ordinal !== undefined) invalid.add(ordinal);
      }
      return valid;
    },
    async store(run: FinishRunFields) {
      await ledger.flush(timeoutMs);
      return write(run, true);
    },
    /** Company post-filtering shares this exact raw-item list with the atomic audit write. */
    retain(records: readonly RawPostingInput[]): void {
      const kept = new Set(records);
      for (const record of valid) {
        if (!kept.has(record) && record.deliveryOrdinal !== undefined) ledger.drop(record.deliveryOrdinal, "company_mismatch", { externalId: record.externalId });
      }
      valid.splice(0, valid.length, ...records);
    },
    /** Audit failures must not replace the channel, cancellation or storage error being handled. */
    async fail(run: FinishRunFields, storeFailed = false): Promise<void> {
      await ledger.flush(timeoutMs);
      try {
        // Await the repository transaction's rejection, including rollback, before fallback.
        // A JavaScript race could leave it holding the very run row fallback must update.
        await write(run, false, storeFailed);
      } catch {
        logger.warn("delivery finalization failed; closing run without audit", context);
        try {
          await finishRun(db, runId, run, timeoutMs);
        } catch {
          logger.warn("could not close run after delivery finalization failed", context);
        }
      }
    },
  };
}

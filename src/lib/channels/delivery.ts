import { createHash } from "node:crypto";

import { z } from "zod";

import { hashPayload } from "./payload-hash";

export const DELIVERY_DISPOSITIONS = [
  "received_uncommitted", "unparsed_response", "provider_error", "no_identity", "duplicate_in_run",
  "outside_window", "company_mismatch", "invalid_shape", "stored", "store_failed", "discarded_on_failure",
] as const;
export const DELIVERY_DROP_REASONS = ["unparsed_response", "provider_error", "no_identity", "duplicate_in_run", "outside_window", "company_mismatch"] as const;
export const DELIVERY_FLAGS = ["unidentified", "date_missing", "date_unparsed", "date_day_precision", "date_unconfirmed", "date_conflict", "body_truncated"] as const;

export type DeliveryDisposition = (typeof DELIVERY_DISPOSITIONS)[number];
export type DeliveryDropReason = (typeof DELIVERY_DROP_REASONS)[number];
export type DeliveryFlag = (typeof DELIVERY_FLAGS)[number];

export const deliveryCountsSchema = z.strictObject({
  dispositions: z.partialRecord(z.enum(DELIVERY_DISPOSITIONS), z.number().int().nonnegative()),
  flags: z.partialRecord(z.enum(DELIVERY_FLAGS), z.number().int().nonnegative()),
  mismatch: z.array(z.string()).optional(),
});
export type DeliveryCounts = z.infer<typeof deliveryCountsSchema>;

export type DeliveryReceipt = { batch: number; items: readonly unknown[] } | { batch: number; text: string; truncated?: boolean };

export interface DeliveryRecorder {
  /** Allocate the next batch number for this attempt, starting at one. */
  beginBatch(): number;
  /** Register the response synchronously, before validation can throw. Never throws. */
  received(receipt: DeliveryReceipt): number[];
  drop(ordinal: number, reason: DeliveryDropReason, options?: { flags?: readonly DeliveryFlag[]; externalId?: string | null }): void;
  flag(ordinal: number, flags: readonly DeliveryFlag[]): void;
  setWindowCutoff(ms: number | null): void;
}

export const NO_DELIVERIES: DeliveryRecorder = {
  beginBatch: () => 0,
  received: () => [],
  drop: () => {},
  flag: () => {},
  setWindowCutoff: () => {},
};

export interface DeliveryCheckpointRow {
  ordinal: number;
  batch: number;
  payloadHash: string;
  payloadBytes: number;
  payloadJson: unknown | null;
  payloadText: string | null;
  flags: DeliveryFlag[];
  receivedAt: Date;
}

export interface DeliveryEntry extends DeliveryCheckpointRow {
  externalId: string | null;
  drops: DeliveryDropReason[];
  confirmed: boolean;
}

export interface DeliveryFinal extends DeliveryCheckpointRow {
  disposition: DeliveryDisposition;
  externalId: string | null;
  confirmed: boolean;
}

interface FinalizeInput {
  stored: ReadonlyMap<number, string>;
  storeFailed: boolean;
  invalid: ReadonlySet<number>;
}

export interface DeliveryLedger extends DeliveryRecorder {
  entries(): readonly DeliveryEntry[];
  /** Wait for writes already started, bounded by the timeout. Never throws. */
  flush(timeoutMs: number): Promise<void>;
  finalize(input: FinalizeInput): DeliveryFinal[];
  windowCutoff(): number | null;
  receivedCount(): number;
}

function textPayload(text: string) {
  return {
    payloadHash: createHash("sha256").update(text).digest("hex"),
    payloadBytes: Buffer.byteLength(text, "utf8"),
    payloadJson: null,
    payloadText: text,
  };
}

function itemPayload(item: unknown) {
  try {
    const serialized = JSON.stringify(item);
    if (serialized !== undefined) {
      const normalized: unknown = JSON.parse(serialized);
      return {
        payloadHash: hashPayload(normalized),
        payloadBytes: Buffer.byteLength(serialized, "utf8"),
        payloadJson: normalized,
        payloadText: null,
      };
    }
  } catch {
    // A non-JSON value is still evidence: retain its text form.
  }
  let text: string;
  try { text = String(item); } catch { text = "[unserializable]"; }
  return textPayload(text);
}

function checkpoint(entry: DeliveryCheckpointRow): DeliveryCheckpointRow {
  return {
    ordinal: entry.ordinal, batch: entry.batch, payloadHash: entry.payloadHash, payloadBytes: entry.payloadBytes,
    payloadJson: entry.payloadJson, payloadText: entry.payloadText, flags: [...entry.flags], receivedAt: new Date(entry.receivedAt),
  };
}

/** Attempt-local receipts and dispositions; the caller injects durable checkpoint writes. */
export function createDeliveryLedger(options: {
  persist?: (rows: readonly DeliveryCheckpointRow[]) => Promise<void>;
  onPersistError?: (error: unknown) => void;
  now?: () => Date;
}): DeliveryLedger {
  const entries: DeliveryEntry[] = [];
  const batches = new Map<number, Map<string, number[]>>();
  const pending = new Set<Promise<void>>();
  let nextBatch = 0;
  let cutoff: number | null = null;

  const reportError = (error: unknown) => {
    try { options.onPersistError?.(error); } catch { /* Logging must not interrupt collection. */ }
  };
  const flag = (ordinal: number, flags: readonly DeliveryFlag[]) => {
    const entry = entries[ordinal];
    if (entry) entry.flags = DELIVERY_FLAGS.filter((code) => entry.flags.includes(code) || flags.includes(code));
  };

  return {
    beginBatch: () => ++nextBatch,
    received(receipt) {
      const hashes = batches.get(receipt.batch) ?? new Map<string, number[]>();
      batches.set(receipt.batch, hashes);
      const occurrences = new Map<string, number>();
      const created: DeliveryEntry[] = [];
      const payloads = "items" in receipt ? receipt.items.map(itemPayload) : [textPayload(receipt.text)];
      const ordinals = payloads.map((payload) => {
        const occurrence = occurrences.get(payload.payloadHash) ?? 0;
        occurrences.set(payload.payloadHash, occurrence + 1);
        const existing = hashes.get(payload.payloadHash) ?? [];
        const reused = existing[occurrence];
        if (reused !== undefined) return reused;
        let receivedAt: Date;
        try { receivedAt = options.now?.() ?? new Date(); } catch { receivedAt = new Date(); }
        const entry: DeliveryEntry = {
          ...payload, ordinal: entries.length, batch: receipt.batch, receivedAt,
          flags: [], drops: [], externalId: null, confirmed: false,
        };
        entries.push(entry);
        created.push(entry);
        existing.push(entry.ordinal);
        hashes.set(payload.payloadHash, existing);
        return entry.ordinal;
      });
      if (created.length > 0 && options.persist) {
        try {
          const write = options.persist(created.map(checkpoint)).then(
            () => { for (const entry of created) entry.confirmed = true; },
            reportError,
          );
          pending.add(write);
          void write.then(() => pending.delete(write));
        } catch (error) {
          reportError(error);
        }
      }
      return ordinals;
    },
    drop(ordinal, reason, dropOptions) {
      const entry = entries[ordinal];
      if (!entry) return;
      entry.drops = DELIVERY_DROP_REASONS.filter((code) => code === reason || entry.drops.includes(code));
      if (dropOptions?.externalId !== undefined) entry.externalId = dropOptions.externalId;
      if (dropOptions?.flags) flag(ordinal, dropOptions.flags);
    },
    flag,
    setWindowCutoff: (ms) => { cutoff = ms; },
    windowCutoff: () => cutoff,
    receivedCount: () => entries.length,
    entries: () => entries.map((entry) => ({ ...entry, ...checkpoint(entry), drops: [...entry.drops] })),
    async flush(timeoutMs) {
      if (pending.size === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([...pending]),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, timeoutMs)); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    finalize(input) {
      return entries.map((entry) => {
        const disposition: DeliveryDisposition = entry.drops.at(0) ?? (
          input.invalid.has(entry.ordinal) ? "invalid_shape" : input.stored.has(entry.ordinal)
            ? input.storeFailed ? "store_failed" : "stored" : "discarded_on_failure"
        );
        return {
          ...checkpoint(entry), disposition, confirmed: entry.confirmed,
          externalId: disposition === "stored" || disposition === "store_failed"
            ? input.stored.get(entry.ordinal) ?? entry.externalId : entry.externalId,
        };
      });
    },
  };
}

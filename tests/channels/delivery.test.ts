// @vitest-environment node
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDeliveryLedger,
  DELIVERY_DISPOSITIONS,
  DELIVERY_DROP_REASONS,
  DELIVERY_FLAGS,
  deliveryCountsSchema,
  NO_DELIVERIES,
  type DeliveryCheckpointRow,
  type DeliveryFinal,
} from "@/lib/channels/delivery";
import { hashPayload } from "@/lib/db/repos/raw-postings";

const RECEIVED_AT = new Date("2026-10-20T12:00:00Z");
const ledger = () => createDeliveryLedger({ now: () => RECEIVED_AT });
const emptyFinal = { stored: new Map<number, string>(), invalid: new Set<number>(), storeFailed: false };

afterEach(() => vi.useRealTimers());

describe("delivery codes", () => {
  it("exposes the persisted vocabulary and its precedence order", () => {
    expect(DELIVERY_DISPOSITIONS).toEqual([
      "received_uncommitted", "unparsed_response", "provider_error", "no_identity", "duplicate_in_run",
      "outside_window", "invalid_shape", "stored", "store_failed", "discarded_on_failure",
    ]);
    expect(DELIVERY_DROP_REASONS).toEqual(["unparsed_response", "provider_error", "no_identity", "duplicate_in_run", "outside_window"]);
    expect(DELIVERY_FLAGS).toEqual([
      "unidentified", "date_missing", "date_unparsed", "date_day_precision", "date_unconfirmed", "date_conflict", "body_truncated",
    ]);
  });
});

describe("delivery receipts", () => {
  it("numbers batches from one and ordinals contiguously across batches", () => {
    const recorder = ledger();
    const first = recorder.beginBatch();
    const second = recorder.beginBatch();
    expect([first, second]).toEqual([1, 2]);
    expect(recorder.received({ batch: first, items: [{ id: "a" }, { id: "b" }] })).toEqual([0, 1]);
    expect(recorder.received({ batch: second, items: [{ id: "c" }] })).toEqual([2]);
    expect(recorder.entries().map((entry: DeliveryCheckpointRow) => [entry.ordinal, entry.batch])).toEqual([[0, 1], [1, 1], [2, 2]]);
    expect(recorder.receivedCount()).toBe(3);
  });

  it("reuses poll and finish ordinals as a multiset within one batch", () => {
    const recorder = ledger();
    const batch = recorder.beginBatch();
    const item = { id: "a" };
    const output = [item, item];
    expect(recorder.received({ batch, items: output })).toEqual([0, 1]);
    expect(recorder.received({ batch, items: output })).toEqual([0, 1]);
    expect(recorder.entries()).toHaveLength(2);
    expect(recorder.received({ batch, items: [{ id: "a" }, item, item] })).toEqual([0, 1, 2]);
    expect(recorder.received({ batch, items: [item] })).toEqual([0]);
    expect(recorder.received({ batch: recorder.beginBatch(), items: [item] })).toEqual([3]);
    expect(recorder.receivedCount()).toBe(4);
  });

  it("reuses hashes independently of the order of records in later responses", () => {
    const recorder = ledger();
    const batch = recorder.beginBatch();
    expect(recorder.received({ batch, items: [{ id: "a" }, { id: "b" }, { id: "a" }] })).toEqual([0, 1, 2]);
    expect(recorder.received({ batch, items: [{ id: "b" }, { id: "a" }, { id: "a" }, { id: "b" }] })).toEqual([1, 0, 2, 3]);
    expect(recorder.received({ batch, items: [] })).toEqual([]);
    expect(recorder.receivedCount()).toBe(4);
  });

  it("retains text with a SHA-256 hash and UTF-8 bytes without inferring a drop or flag", () => {
    const recorder = ledger();
    const batch = recorder.beginBatch();
    const text = "Zürich – 東京";
    expect(recorder.received({ batch, text, truncated: true })).toEqual([0]);
    expect(recorder.received({ batch, text })).toEqual([0]);
    expect(recorder.entries()).toEqual([expect.objectContaining({
      ordinal: 0, batch, payloadText: text, payloadJson: null,
      payloadHash: createHash("sha256").update(text).digest("hex"), payloadBytes: 18,
      receivedAt: RECEIVED_AT, drops: [], flags: [], confirmed: false, externalId: null,
    })]);
    expect(recorder.finalize(emptyFinal)[0]?.disposition).toBe("discarded_on_failure");
    recorder.drop(0, "unparsed_response", { flags: ["body_truncated"] });
    expect(recorder.finalize(emptyFinal)[0]).toMatchObject({ disposition: "unparsed_response", flags: ["body_truncated"] });
  });

  it("uses the existing raw payload hash and JSON serialization bytes", () => {
    const recorder = ledger();
    const item = { z: "東京", nested: { b: 2, a: 1 } };
    recorder.received({ batch: recorder.beginBatch(), items: [item] });
    expect(recorder.entries()[0]).toMatchObject({
      payloadJson: item, payloadText: null, payloadHash: hashPayload(item),
      payloadBytes: Buffer.byteLength(JSON.stringify(item), "utf8"), receivedAt: RECEIVED_AT,
    });
  });

  it("keeps non-serializable values as text without throwing or adding flags", () => {
    const recorder = ledger();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => recorder.received({ batch: recorder.beginBatch(), items: [42n, cycle] })).not.toThrow();
    expect(recorder.entries().map((entry: DeliveryCheckpointRow & { drops: readonly string[] }) => ({ text: entry.payloadText, json: entry.payloadJson, flags: entry.flags, drops: entry.drops }))).toEqual([
      { text: "42", json: null, flags: [], drops: [] },
      { text: "[object Object]", json: null, flags: [], drops: [] },
    ]);
    expect(recorder.receivedCount()).toBe(2);
  });

  it("makes every method safe, including drops and flags for unknown or negative ordinals", async () => {
    const recorder = ledger();
    expect(() => recorder.beginBatch()).not.toThrow();
    expect(() => recorder.received({ batch: 1, items: [] })).not.toThrow();
    for (const ordinal of [-1, 99]) {
      expect(() => recorder.drop(ordinal, "no_identity", { flags: ["unidentified"] })).not.toThrow();
      expect(() => recorder.flag(ordinal, ["date_missing"])).not.toThrow();
    }
    expect(() => recorder.setWindowCutoff(RECEIVED_AT.getTime())).not.toThrow();
    expect(recorder.windowCutoff()).toBe(RECEIVED_AT.getTime());
    expect(() => recorder.setWindowCutoff(null)).not.toThrow();
    expect(recorder.windowCutoff()).toBeNull();
    expect(() => recorder.entries()).not.toThrow();
    expect(() => recorder.receivedCount()).not.toThrow();
    expect(() => recorder.finalize({ stored: new Map([[-1, "unknown"]]), invalid: new Set([99]), storeFailed: true })).not.toThrow();
    expect(recorder.entries()).toEqual([]);
    await expect(recorder.flush(10)).resolves.toBeUndefined();
  });
});

describe("final dispositions", () => {
  it("chooses the earlier drop code regardless of call order, ahead of invalid and stored", () => {
    for (const earlier of DELIVERY_DROP_REASONS) {
      for (const later of DELIVERY_DROP_REASONS.slice(DELIVERY_DROP_REASONS.indexOf(earlier))) {
        for (const reasons of [[earlier, later], [later, earlier]]) {
          const recorder = ledger();
          recorder.received({ batch: recorder.beginBatch(), items: [{ id: "a" }] });
          for (const reason of reasons) recorder.drop(0, reason);
          expect(recorder.finalize({ ...emptyFinal, stored: new Map([[0, "a"]]) })[0]?.disposition).toBe(earlier);
          expect(recorder.finalize({ stored: new Map([[0, "a"]]), invalid: new Set([0]), storeFailed: false })[0]?.disposition).toBe(earlier);
        }
      }
    }
  });

  it("prioritizes invalid over stored, then stored or store failure, then discarded", () => {
    const recorder = ledger();
    recorder.received({ batch: recorder.beginBatch(), items: ["invalid", "stored", "discarded"] });
    const input = { stored: new Map([[0, "a"], [1, "b"]]), invalid: new Set([0]), storeFailed: false };
    expect(recorder.finalize(input).map((entry: DeliveryFinal) => entry.disposition)).toEqual(["invalid_shape", "stored", "discarded_on_failure"]);
    expect(recorder.finalize({ ...input, storeFailed: true }).map((entry: DeliveryFinal) => entry.disposition)).toEqual(["invalid_shape", "store_failed", "discarded_on_failure"]);
  });

  it("combines flags as an ordered set and retains external ids from drops and stored postings", () => {
    const recorder = ledger();
    recorder.received({ batch: recorder.beginBatch(), items: [{ id: "dropped" }, { id: "stored" }] });
    recorder.flag(0, ["body_truncated", "date_conflict", "date_unconfirmed"]);
    recorder.drop(0, "outside_window", { flags: ["date_missing", "date_day_precision", "date_unparsed"], externalId: "dropped-id" });
    recorder.flag(0, ["unidentified", "date_missing"]);
    recorder.flag(1, ["unidentified", "unidentified"]);
    const final = recorder.finalize({ ...emptyFinal, stored: new Map([[1, "stored-id"]]) });
    expect(final[0]).toMatchObject({ externalId: "dropped-id", flags: [...DELIVERY_FLAGS], disposition: "outside_window" });
    expect(final[1]).toMatchObject({ externalId: "stored-id", flags: ["unidentified"], disposition: "stored" });
    expect(recorder.entries()[0]?.externalId).toBe("dropped-id");
  });
});

describe("delivery checkpoints", () => {
  it("finishes flushing as soon as the pending checkpoint commits", async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<void>();
    const recorder = createDeliveryLedger({ persist: () => pending.promise, now: () => RECEIVED_AT });
    recorder.received({ batch: recorder.beginBatch(), items: ["item"] });
    let finished = false;
    const flushing = recorder.flush(100).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(20);
    expect(finished).toBe(false);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(true);
    await expect(flushing).resolves.toBeUndefined();
    expect(recorder.entries()[0]?.confirmed).toBe(true);
  });

  it("persists only new rows and confirms each write only after it resolves", async () => {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const persist = vi.fn<(rows: readonly DeliveryCheckpointRow[]) => Promise<void>>()
      .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const recorder = createDeliveryLedger({ now: () => RECEIVED_AT, persist });
    const batch = recorder.beginBatch();
    recorder.received({ batch, items: [{ id: "a" }] });
    recorder.received({ batch, items: [{ id: "a" }] });
    recorder.received({ batch, items: [{ id: "a" }, { id: "b" }] });
    expect(persist.mock.calls.map(([rows]) => rows.map((row) => row.ordinal))).toEqual([[0], [1]]);
    expect(recorder.entries().map((entry: { confirmed: boolean }) => entry.confirmed)).toEqual([false, false]);
    first.resolve();
    await first.promise;
    await Promise.resolve();
    expect(recorder.entries().map((entry: { confirmed: boolean }) => entry.confirmed)).toEqual([true, false]);
    second.resolve();
    await recorder.flush(100);
    expect(recorder.entries().map((entry: { confirmed: boolean }) => entry.confirmed)).toEqual([true, true]);
    expect(recorder.finalize(emptyFinal).map((entry: DeliveryFinal) => entry.confirmed)).toEqual([true, true]);
  });

  it("reports rejected writes and leaves their rows unconfirmed without throwing", async () => {
    const failure = new Error("checkpoint unavailable");
    const onPersistError = vi.fn();
    const recorder = createDeliveryLedger({ persist: async () => { throw failure; }, onPersistError, now: () => RECEIVED_AT });
    expect(() => recorder.received({ batch: recorder.beginBatch(), items: [{ id: "a" }] })).not.toThrow();
    await expect(recorder.flush(100)).resolves.toBeUndefined();
    expect(onPersistError).toHaveBeenCalledWith(failure);
    expect(recorder.entries()[0]?.confirmed).toBe(false);
  });

  it("contains synchronous persist failures and errors thrown by the error callback", async () => {
    const recorder = createDeliveryLedger({
      persist: () => { throw new Error("writer failed synchronously"); },
      onPersistError: () => { throw new Error("logger failed"); },
      now: () => RECEIVED_AT,
    });
    expect(() => recorder.received({ batch: recorder.beginBatch(), text: "body" })).not.toThrow();
    await expect(recorder.flush(100)).resolves.toBeUndefined();
    expect(recorder.entries()[0]?.confirmed).toBe(false);
  });

  it("waits for pending writes and returns at the timeout when a write never settles", async () => {
    vi.useFakeTimers();
    const recorder = createDeliveryLedger({ persist: () => new Promise<void>(() => {}), now: () => RECEIVED_AT });
    recorder.received({ batch: recorder.beginBatch(), text: "body" });
    let finished = false;
    const flushing = recorder.flush(50).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(49);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(flushing).resolves.toBeUndefined();
    expect(finished).toBe(true);
    expect(recorder.entries()[0]?.confirmed).toBe(false);
  });
});

describe("no-op deliveries", () => {
  it("returns no ordinals, never allocates a batch and safely ignores mutations", () => {
    expect(NO_DELIVERIES.beginBatch()).toBe(0);
    expect(NO_DELIVERIES.received({ batch: 0, items: ["item"] })).toEqual([]);
    expect(NO_DELIVERIES.received({ batch: 0, text: "body", truncated: true })).toEqual([]);
    expect(() => {
      NO_DELIVERIES.drop(-1, "unparsed_response", { flags: ["body_truncated"], externalId: "ignored" });
      NO_DELIVERIES.flag(99, ["date_missing"]);
      NO_DELIVERIES.setWindowCutoff(RECEIVED_AT.getTime());
      NO_DELIVERIES.setWindowCutoff(null);
    }).not.toThrow();
    expect(NO_DELIVERIES.beginBatch()).toBe(0);
  });
});

describe("delivery counts validation", () => {
  it("accepts partial records and optional mismatch codes", () => {
    expect(deliveryCountsSchema.safeParse({ dispositions: {}, flags: {} }).success).toBe(true);
    expect(deliveryCountsSchema.safeParse({ dispositions: { stored: 2, no_identity: 0 }, flags: { unidentified: 1 }, mismatch: ["delivered_sum"] }).success).toBe(true);
  });

  it.each([
    { dispositions: { unknown: 1 }, flags: {} },
    { dispositions: {}, flags: { unknown: 1 } },
    { dispositions: { stored: -1 }, flags: {} },
    { dispositions: {}, flags: { unidentified: -1 } },
    { dispositions: { stored: 1.5 }, flags: {} },
    { dispositions: {}, flags: { unidentified: 1.5 } },
    { dispositions: {}, flags: {}, extra: true },
  ])("rejects invalid count records: %j", (input) => {
    expect(deliveryCountsSchema.safeParse(input).success).toBe(false);
  });
});

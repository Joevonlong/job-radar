// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { createDeliveryLedger } from "@/lib/channels/delivery";
import { runActorSync } from "@/lib/channels/linkedin/apify/client";
import { MAX_RESPONSE_CHARS } from "@/lib/channels/linkedin/apify/contract";

import { apifyConfig, berlinQuery, fakeApify, harness, makeChannel, NOW, response } from "./helpers";

const JOB = { id: "7000001", title: "Platform Engineer", postedDate: "2026-10-07T07:00:00Z" };
const finalizeEmpty = { stored: new Map<number, string>(), invalid: new Set<number>(), storeFailed: false };

describe("Apify delivery capture", () => {
  it.each([
    { name: "non-JSON", body: () => "<html>upstream failed</html>", message: "Apify response is not valid JSON" },
    { name: "JSON object", body: () => '{"items":[]}', message: "Apify response is not a JSON array of dataset items" },
    { name: "oversized array", body: () => `["${"x".repeat(MAX_RESPONSE_CHARS)}"]`, message: "Apify dataset exceeds the size limit" },
  ])("retains the whole $name body before throwing", async ({ body, message }) => {
    const text = body();
    const ledger = createDeliveryLedger({});
    const channel = makeChannel();
    const { ctx } = await harness(channel, fakeApify([response(201, text)]), { deliveries: ledger });

    await expect(channel.collect(berlinQuery(), ctx)).rejects.toMatchObject({ code: "parse", message });
    expect(ledger.entries()).toHaveLength(1);
    expect(ledger.entries()[0]).toMatchObject({ ordinal: 0, batch: 1, payloadText: text, payloadJson: null, drops: ["unparsed_response"] });
    expect(ledger.finalize(finalizeEmpty)[0]?.disposition).toBe("unparsed_response");
  });

  it("returns client ordinals aligned with raw items", async () => {
    const ledger = createDeliveryLedger({});
    const channel = makeChannel();
    const { ctx } = await harness(channel, fakeApify([response(201, [JOB])]), { deliveries: ledger });
    const result = await runActorSync({ ctx, token: "test-token", url: "https://api.apify.com/v2/acts/example/run-sync-get-dataset-items", input: {}, timeoutSecs: 1 });
    expect(result).toEqual({ items: [JOB], ordinals: [0] });
    expect(ledger.entries()).toMatchObject([{ ordinal: 0, batch: 1, payloadJson: JOB }]);
  });

  it("retains an earlier sub-run when the second sub-run is cancelled", async () => {
    const ledger = createDeliveryLedger({});
    const controller = new AbortController();
    const reason = new DOMException("Cancelled cycle", "AbortError");
    const channel = makeChannel();
    const provider = fakeApify([response(201, [JOB]), () => { controller.abort(reason); throw reason; }]);
    const { ctx } = await harness(channel, provider, { deliveries: ledger, signal: controller.signal });
    const begin = vi.spyOn(ledger, "beginBatch");

    await expect(channel.collect(berlinQuery({ keywords: ["A".repeat(120), "B".repeat(120)] }), ctx)).rejects.toBe(reason);
    expect(provider.requests).toHaveLength(2);
    expect(begin.mock.results.map((result) => result.value)).toEqual([1, 2]);
    expect(ledger.entries()).toMatchObject([{ ordinal: 0, batch: 1, payloadJson: JOB }]);
    expect(ledger.finalize(finalizeEmpty)).toMatchObject([{ disposition: "discarded_on_failure", payloadJson: JOB }]);
  });
});

describe("Apify channel dispositions", () => {
  it.each([
    { name: "provider error", items: [{ error: "Example provider failure" }], disposition: "provider_error", externalId: null },
    { name: "missing identity", items: [{ title: "Unidentified role" }], disposition: "no_identity", externalId: null },
    { name: "non-object", items: [null], disposition: "no_identity", externalId: null },
    { name: "duplicate", items: [JOB, JOB], disposition: "duplicate_in_run", externalId: JOB.id },
    { name: "outside window", items: [{ ...JOB, postedDate: "2026-10-05" }], disposition: "outside_window", externalId: JOB.id },
  ])("records $name without losing its original ordinal", async ({ items, disposition, externalId }) => {
    const ledger = createDeliveryLedger({});
    const channel = makeChannel();
    const { ctx } = await harness(channel, fakeApify([response(201, items)]), { deliveries: ledger });
    const postings = await channel.collect(berlinQuery({ windowHours: 10 }), ctx);
    const droppedOrdinal = items.length - 1;

    expect(ledger.entries()).toHaveLength(items.length);
    expect(ledger.entries()[droppedOrdinal]).toMatchObject({ ordinal: droppedOrdinal, payloadJson: items[droppedOrdinal], drops: [disposition], externalId });
    expect(ledger.finalize(finalizeEmpty)[droppedOrdinal]).toMatchObject({ disposition, externalId });
    expect(postings.map((posting) => posting.deliveryOrdinal)).toEqual(disposition === "duplicate_in_run" ? [0] : []);
    if (disposition === "outside_window") expect(ledger.entries()[0]?.flags).toEqual(["date_day_precision"]);
  });

  it("returns ordinals across sub-runs and preserves billing of non-error records", async () => {
    const ledger = createDeliveryLedger({});
    const second = { ...JOB, id: "7000002", postedDate: undefined };
    const channel = makeChannel();
    const config = apifyConfig((block) => { block.price_per_1k_usd = 2; block.run_start_usd = 0.01; });
    const { ctx } = await harness(channel, fakeApify([response(201, [JOB, { error: "Example error" }]), response(201, [second])]), { deliveries: ledger, config });
    const consume = vi.spyOn(ctx.budget, "consume");
    const postings = await channel.collect(berlinQuery({ keywords: ["A".repeat(120), "B".repeat(120)] }), ctx);

    expect(consume.mock.calls).toEqual([[1, { costUsd: 0.012, allowOverspend: true }], [1, { costUsd: 0.012, allowOverspend: true }]]);
    expect(postings.map((posting) => posting.deliveryOrdinal)).toEqual([0, 2]);
    expect(ledger.entries().map(({ ordinal, batch }) => ({ ordinal, batch }))).toEqual([{ ordinal: 0, batch: 1 }, { ordinal: 1, batch: 1 }, { ordinal: 2, batch: 2 }]);
    expect(ledger.entries()[2]?.flags).toEqual(["date_missing"]);
    expect(ledger.finalize({ ...finalizeEmpty, stored: new Map([[0, JOB.id], [2, second.id]]) }).map((entry) => entry.disposition)).toEqual(["stored", "provider_error", "stored"]);
  });

  it.each([10, 24])("reports the actual cutoff for a %i-hour query", async (windowHours) => {
    const ledger = createDeliveryLedger({});
    const cutoff = vi.spyOn(ledger, "setWindowCutoff");
    const channel = makeChannel();
    const { ctx } = await harness(channel, fakeApify(), { deliveries: ledger });
    await channel.collect(berlinQuery({ windowHours }), ctx);
    const expected = windowHours === 10 ? NOW.getTime() - 10 * 3_600_000 : null;
    expect(cutoff).toHaveBeenCalledExactlyOnceWith(expected);
    expect(ledger.windowCutoff()).toBe(expected);
  });
});

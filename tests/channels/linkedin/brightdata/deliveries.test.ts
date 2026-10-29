// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { createDeliveryLedger } from "@/lib/channels/delivery";
import { BrightDataClient } from "@/lib/channels/linkedin/brightdata/client";

import { berlinQuery, brightConfig, fakeProvider, harness, makeChannel, NOW, response, SNAPSHOT_ID } from "./helpers";

const JOB = { job_posting_id: "7000001", job_title: "Platform Engineer", job_posted_date: "2026-10-07T07:00:00Z" };
const finalizeEmpty = { stored: new Map<number, string>(), invalid: new Set<number>(), storeFailed: false };

describe("Bright Data delivery capture", () => {
  it("retains a snapshot that is neither JSON nor NDJSON before throwing", async () => {
    const text = '{"partial":true}\nupstream failed';
    const ledger = createDeliveryLedger({});
    const channel = makeChannel();
    const { ctx } = await harness(channel, fakeProvider({ snapshotFirst: [response(200, text)] }), { deliveries: ledger });
    await expect(channel.collect(berlinQuery(), ctx)).rejects.toMatchObject({ code: "parse", message: "Bright Data snapshot is neither a JSON array nor NDJSON" });
    expect(ledger.entries()).toHaveLength(1);
    expect(ledger.entries()[0]).toMatchObject({ ordinal: 0, batch: 1, payloadText: text, payloadJson: null, drops: ["unparsed_response"] });
    expect(ledger.finalize(finalizeEmpty)[0]?.disposition).toBe("unparsed_response");
  });

  it("returns client ordinals and excludes trigger and progress metadata from capture", async () => {
    const ledger = createDeliveryLedger({});
    const channel = makeChannel();
    const { ctx } = await harness(channel, fakeProvider({ records: [JOB] }), { deliveries: ledger });
    const client = new BrightDataClient({ ctx, apiKey: "test-key", datasetId: "example-dataset", pollIntervalMs: 1, timeoutMs: 100 });
    expect(await client.run([{ location: "Example City", keyword: "Platform Engineer", country: "DE" }], 10)).toEqual({ snapshotId: SNAPSHOT_ID, items: [JOB], ordinals: [0] });
    expect(ledger.entries()).toMatchObject([{ ordinal: 0, batch: 1, payloadJson: JOB }]);
    expect(ledger.entries()).toHaveLength(1);
  });
});

describe("Bright Data channel dispositions", () => {
  it.each([
    { name: "provider error", items: [{ error: "Example provider failure" }], disposition: "provider_error", externalId: null },
    { name: "missing identity", items: [{ job_title: "Unidentified role" }], disposition: "no_identity", externalId: null },
    { name: "non-object", items: [null], disposition: "no_identity", externalId: null },
    { name: "duplicate", items: [JOB, JOB], disposition: "duplicate_in_run", externalId: JOB.job_posting_id },
    { name: "outside window", items: [{ ...JOB, job_posted_date: "2026-10-05" }], disposition: "outside_window", externalId: JOB.job_posting_id },
  ])("records $name and aligns returned ordinals with the snapshot", async ({ items, disposition, externalId }) => {
    const ledger = createDeliveryLedger({});
    const channel = makeChannel();
    const { ctx } = await harness(channel, fakeProvider({ records: items }), { deliveries: ledger });
    const postings = await channel.collect(berlinQuery({ windowHours: 10 }), ctx);
    const ordinal = items.length - 1;
    expect(ledger.entries()).toHaveLength(items.length);
    expect(ledger.entries()[ordinal]).toMatchObject({ ordinal, payloadJson: items[ordinal], externalId, drops: [disposition] });
    expect(ledger.finalize(finalizeEmpty)[ordinal]).toMatchObject({ disposition, externalId });
    expect(postings.map((posting) => posting.deliveryOrdinal)).toEqual(disposition === "duplicate_in_run" ? [0] : []);
    if (disposition === "outside_window") expect(ledger.entries()[0]?.flags).toEqual(["date_day_precision"]);
  });

  it("counts every non-error record in usage even inside the free allowance", async () => {
    const ledger = createDeliveryLedger({});
    const missing = { job_title: "No identity" };
    const old = { ...JOB, job_posting_id: "7000002", job_posted_date: "2026-10-05" };
    const items = [{ error: "Example error" }, JOB, missing, JOB, old];
    const config = brightConfig((raw) => {
      const linkedin = raw.linkedin as Record<string, unknown>;
      const block = linkedin.brightdata as Record<string, unknown>;
      block.free_records_per_month = 100;
    });
    const channel = makeChannel();
    const { ctx } = await harness(channel, fakeProvider({ records: items }), { deliveries: ledger, config });
    const consume = vi.spyOn(ctx.budget, "consume");
    const postings = await channel.collect(berlinQuery({ windowHours: 10 }), ctx);
    expect(consume).toHaveBeenCalledExactlyOnceWith(4, { allowOverspend: true });
    expect(ctx.budget.snapshot()).toMatchObject({ records: 4, usd: 0, freeRecordsLeft: 96 });
    expect(postings.map((posting) => posting.deliveryOrdinal)).toEqual([1]);
    expect(ledger.entries()).toHaveLength(5);
    expect(ledger.entries()[2]?.flags).toContain("date_missing");
    expect(ledger.finalize({ ...finalizeEmpty, stored: new Map([[1, JOB.job_posting_id]]) }).map((entry) => entry.disposition)).toEqual(["provider_error", "stored", "no_identity", "duplicate_in_run", "outside_window"]);
  });

  it.each([10, 24])("reports the actual cutoff for a %i-hour query", async (windowHours) => {
    const ledger = createDeliveryLedger({});
    const cutoff = vi.spyOn(ledger, "setWindowCutoff");
    const channel = makeChannel();
    const { ctx } = await harness(channel, fakeProvider(), { deliveries: ledger });
    await channel.collect(berlinQuery({ windowHours }), ctx);
    const expected = windowHours === 10 ? NOW.getTime() - 10 * 3_600_000 : null;
    expect(cutoff).toHaveBeenCalledExactlyOnceWith(expected);
    expect(ledger.windowCutoff()).toBe(expected);
  });
});

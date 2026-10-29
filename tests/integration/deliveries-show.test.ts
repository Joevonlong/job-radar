import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { createDeliveryLedger } from "@/lib/channels/delivery";
import { hashPayload } from "@/lib/channels/payload-hash";
import { closeDb, getDb } from "@/lib/db/client";
import { getDeliveryRun } from "@/lib/db/queries/deliveries";
import { deliveryTablesReady, finishRunWithDeliveries, insertDeliveryCheckpoint, resetDeliveryTablesCache } from "@/lib/db/repos/deliveries";
import { upsertRawPostings } from "@/lib/db/repos/raw-postings";
import { createRun } from "@/lib/db/repos/runs";
import { deliveryText, showDeliveries } from "@/lib/deliveries/cli";

const url = inject("testDatabaseUrl");
const channelId = "delivery-show-test";
const words = deliveryText("en");
const dropped = { body: "private dropped payload" };
const stored = { body: "private original payload" };
const externalId = "private-external-id";
let runId: number;

beforeAll(() => { process.env.DATABASE_URL = url; });
beforeEach(async () => {
  resetDeliveryTablesCache();
  await getDb().execute(sql`insert into channels (id, family, kind) values (${channelId}, 'linkedin', 'paid')`);
  runId = (await createRun(getDb(), { channelId })).id;
});
afterAll(async () => { resetDeliveryTablesCache(); await closeDb(); });

async function finalize(id: number, payload: unknown, withDrop = false) {
  const ledger = createDeliveryLedger({});
  const ordinals = ledger.received({ batch: ledger.beginBatch(), items: withDrop ? [payload, dropped] : [payload] });
  if (withDrop) ledger.drop(ordinals[1]!, "no_identity", { flags: ["date_missing"] });
  await finishRunWithDeliveries(getDb(), {
    runId: id, channelId, ledger: "client", windowCutoffAt: null,
    expected: { delivered: withDrop ? 2 : 1 },
    items: ledger.finalize({ stored: new Map([[ordinals[0]!, externalId]]), storeFailed: false, invalid: new Set() }),
    raw: { items: [{ externalId, url: "https://jobs.example.test/posting", payload }] },
    run: { status: "succeeded", usageUnits: 5, fetched: 1 },
  });
}

function show(options: { runId?: number; payload?: boolean; json?: boolean; dispositions?: ("stored" | "no_identity")[] } = {}, ready = () => deliveryTablesReady(getDb())) {
  const args = { runId, payload: false, json: false, dispositions: [], ...options };
  return showDeliveries(args, { tablesReady: ready, query: (id, payload) => getDeliveryRun(getDb(), id, { payload }) }, words);
}

describe("delivery query and CLI formatting", () => {
  it("defaults to codes and counts with no external ids or payloads in text or JSON", async () => {
    await finalize(runId, stored, true);
    for (const json of [false, true]) {
      const result = await show({ json });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("stored");
      expect(result.output).toContain("no_identity");
      expect(result.output).toContain("date_missing");
      expect(result.output).not.toContain(externalId);
      expect(result.output).not.toContain("private original payload");
      expect(result.output).not.toContain("private dropped payload");
      const queried = await getDeliveryRun(getDb(), runId);
      expect(queried?.items[0]).not.toHaveProperty("payload");
      expect(queried?.items[0]).not.toHaveProperty("externalId");
    }
    const payloads = await show({ payload: true });
    expect(payloads.output).toContain("private dropped payload");
    expect(payloads.output).toContain("private original payload");
  });

  it("does not substitute a newer raw payload after the same id changed twice", async () => {
    await finalize(runId, stored);
    await upsertRawPostings(getDb(), { channelId, runId, items: [{ externalId, url: null, payload: { body: "intermediate payload" } }] });
    const latest = (await createRun(getDb(), { channelId })).id;
    await finalize(latest, { body: "latest delivery payload" });
    const old = await show({ payload: true });
    expect(old.output).toContain("payload of this delivery not kept");
    expect(old.output).not.toContain("latest delivery payload");
    expect((await show({ runId: latest, payload: true })).output).toContain("latest delivery payload");
  });

  it("prints a dropped non-JSON response verbatim only with payload enabled", async () => {
    const text = "<html>private response body</html>";
    const ledger = createDeliveryLedger({});
    const [ordinal] = ledger.received({ batch: ledger.beginBatch(), text });
    ledger.drop(ordinal!, "unparsed_response");
    await finishRunWithDeliveries(getDb(), {
      runId, channelId, ledger: "client", windowCutoffAt: null, expected: { delivered: 1 },
      items: ledger.finalize({ stored: new Map(), invalid: new Set(), storeFailed: false }), run: { status: "failed" },
    });
    expect((await show()).output).not.toContain(text);
    expect((await show({ payload: true })).output).toContain(text);
    const filtered = JSON.parse((await show({ json: true, dispositions: ["stored"] })).output);
    expect(filtered.items).toEqual([]);
    expect(filtered.summary.delivered).toBe(1);
  });

  it("shows checkpoints as an incomplete attempt, deriving counts", async () => {
    await insertDeliveryCheckpoint(getDb(), { runId, channelId, rows: [{ ordinal: 0, batch: 1, payloadHash: hashPayload(dropped), payloadBytes: 20, payloadJson: dropped, payloadText: null, flags: ["date_missing"], receivedAt: new Date() }] });
    const result = await show({ json: true });
    const data = JSON.parse(result.output);
    expect(data.message).toContain("attempt not completed");
    expect(data.summary.delivered).toBe(1);
    expect(data.summary.counts.dispositions).toEqual({ received_uncommitted: 1 });
    expect(data.summary.counts.flags).toEqual({ date_missing: 1 });
  });

  it("reports missing setup without dropping tables, and returns one for an unknown run", async () => {
    expect(await show({}, async () => false)).toMatchObject({ exitCode: 0, output: expect.stringContaining("not set up yet") });
    expect(await show({ runId: runId + 1 })).toMatchObject({ exitCode: 1, output: expect.stringContaining("not found") });
  });
});

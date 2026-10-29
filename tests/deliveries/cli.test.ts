// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import type { DeliveryRunView } from "@/lib/db/queries/deliveries";
import { deliveryText, formatDeliveries, parseDeliveryArgs, showDeliveries } from "@/lib/deliveries/cli";

const words = deliveryText("en");
const options = { payload: false, json: false, dispositions: [] };
const view: DeliveryRunView = {
  runId: 7, distinctIds: 1,
  summary: { ledger: "client", delivered: 2, billedUnits: 5, distinctIds: 1, windowCutoffAt: "2026-10-01T00:00:00.000Z", counts: { dispositions: { stored: 1, no_identity: 1 }, flags: { date_missing: 1 }, mismatch: ["stored_count"] } },
  items: [
    { ordinal: 0, batch: 1, disposition: "stored", flags: [], payloadBytes: 20, payloadHash: "abcdef1234567890", externalId: "private-id", payload: { state: "not_kept" } },
    { ordinal: 1, batch: 2, disposition: "no_identity", flags: ["date_missing"], payloadBytes: 50, payloadHash: "123456abcdef7890", externalId: null, payload: { state: "kept", json: { text: "private payload" }, text: null } },
  ],
};

describe("delivery CLI", () => {
  it.each([false, true])("excludes private fields by default (json=%s)", (json) => {
    const result = formatDeliveries(view, { ...options, json }, words);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("no_identity");
    expect(result.output).toContain("date_missing");
    expect(result.output).toContain("stored_count");
    expect(result.output).toContain("abcdef123456");
    expect(result.output).not.toContain("private-id");
    expect(result.output).not.toContain("private payload");
    expect(result.output).not.toContain('"payload"');
  });

  it("shows payloads only when requested, and explains an unavailable stored payload", () => {
    const result = formatDeliveries(view, { ...options, payload: true }, words);
    expect(result.output).toContain("private payload");
    expect(result.output).toContain("payload of this delivery not kept");
  });

  it("filters items by repeated disposition codes, keeping the complete summary", () => {
    const result = formatDeliveries(view, { ...options, json: true, dispositions: ["no_identity"] }, words);
    const data = JSON.parse(result.output);
    expect(data.summary.delivered).toBe(2);
    expect(data.items).toHaveLength(1);
    expect(data.items[0].ordinal).toBe(1);
  });

  it("derives incomplete counts before filtering", () => {
    const result = formatDeliveries({ ...view, summary: null }, { ...options, json: true, dispositions: ["stored"] }, words);
    const data = JSON.parse(result.output);
    expect(data.message).toContain("attempt not completed");
    expect(data.summary.delivered).toBe(2);
    expect(data.summary.counts.dispositions).toEqual({ stored: 1, no_identity: 1 });
    expect(data.summary.counts.flags).toEqual({ date_missing: 1 });
  });

  it("uses an injected readiness check without querying missing tables", async () => {
    const query = vi.fn(async () => view);
    const result = await showDeliveries({ ...options, runId: 7 }, { tablesReady: async () => false, query }, words);
    expect(result).toMatchObject({ exitCode: 0, output: expect.stringContaining("not set up yet") });
    expect(query).not.toHaveBeenCalled();
    expect(formatDeliveries(null, options, words)).toMatchObject({ exitCode: 1, output: expect.stringContaining("not found") });
  });

  it("validates a run, repeated codes, locale and flags", () => {
    expect(parseDeliveryArgs(["--run", "7", "--disposition", "stored", "--disposition", "no_identity", "--payload", "--json", "--lang", "en"])).toMatchObject({ runId: 7, dispositions: ["stored", "no_identity"], payload: true, json: true, lang: "en" });
    for (const args of [[], ["--run", "0"], ["--run", "1.2"], ["--run", "9007199254740992"], ["--run", "7", "--disposition", "unknown"], ["--run", "7", "--lang", "unknown"], ["--run", "7", "--other"], ["--run", "7", "extra"]]) {
      expect(() => parseDeliveryArgs(args)).toThrow();
    }
  });
});

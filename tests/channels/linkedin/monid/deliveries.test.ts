// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { createDeliveryLedger, NO_DELIVERIES, type DeliveryRecorder } from "@/lib/channels/delivery";
import { MonidClient } from "@/lib/channels/linkedin/monid/client";

import jobs from "../../../fixtures/monid/harvestapi-jobs.json";
import responses from "../../../fixtures/monid/responses.json";
import { completed, FAKE_KEY, harness, NOW, query, response, settings, type Answer } from "./helpers";

const JOB = { ...jobs[0], id: "7000001", postedDate: "2026-10-26T08:00:00Z" };
const finalizeEmpty = { stored: new Map<number, string>(), invalid: new Set<number>(), storeFailed: false };
const shortSettings = () => settings({ timeout_ms: 6 });

describe("Monid malformed response capture and accounting", () => {
  for (const phase of ["post", "poll", "stop"] as const) {
    for (const truncated of [false, true]) {
      it.each(["client", "channel"] as const)(`retains ${phase} ${truncated ? "truncated" : "non-JSON"} text through the %s without changing billing`, async (seam) => {
        const text = truncated ? '{"output":[' : "<html>upstream failed</html>";
        const run = async (deliveries: DeliveryRecorder) => {
          const bad = response(200, text);
          const answers: Answer[] = phase === "post" ? [bad] : phase === "poll"
            ? [response(202, responses.accepted), bad, response(200, completed())]
            : [response(202, responses.accepted), response(200, responses.running), bad];
          const h = await harness(answers, { deliveries, settings: shortSettings() });
          const reads = vi.fn();
          if (truncated) {
            const request = h.ctx.http.request.bind(h.ctx.http);
            vi.spyOn(h.ctx.http, "request").mockImplementation(async (url, init) => {
              const result = await request(url, init);
              const target = phase === "post" ? url.endsWith("/v1/run") : phase === "stop" ? url.endsWith("/stop") : init?.method !== "POST";
              if (!target) return result;
              return { ...result, textUpTo: async (max: number) => {
                // Read via the transport first so its body timeout is cleaned up as usual.
                if (!result.textUpTo) throw new Error("Expected a bounded body reader");
                await result.textUpTo(max);
                reads(max);
                return { text, truncated: true };
              } };
            });
          }
          const consume = vi.spyOn(h.ctx.budget, "consume");
          const action = seam === "channel" ? h.channel.collect(query(), h.ctx) : new MonidClient({
            ctx: h.ctx, apiKey: FAKE_KEY, settings: shortSettings(), now: () => NOW.getTime() + h.sleeps.reduce((sum, ms) => sum + ms, 0),
            sleep: async (ms, signal) => { signal?.throwIfAborted(); h.sleeps.push(ms); }, stopFetch: h.fetch,
          }).run({ jobTitles: ["Platform Engineer"], locations: ["Example City"], maxItems: 10 }, 10);
          await expect(action).rejects.toMatchObject({ code: phase === "stop" ? "network" : "parse" });
          if (truncated) expect(reads).toHaveBeenCalledOnce();
          expect(h.requests.map((request) => request.path)).toEqual(phase === "post" ? ["/v1/run"] : ["/v1/run", "/v1/runs/run_example", "/v1/runs/run_example/stop"]);
          return { calls: consume.mock.calls, usage: h.ctx.budget.snapshot() };
        };
        const baseline = await run(NO_DELIVERIES);
        const ledger = createDeliveryLedger({});
        const captured = await run(ledger);
        expect(captured.calls).toEqual(baseline.calls);
        expect(captured.calls).toHaveLength(1);
        expect(captured.usage).toEqual(baseline.usage);
        expect(ledger.entries()).toHaveLength(1);
        expect(ledger.entries()[0]).toMatchObject({ ordinal: 0, batch: 1, payloadText: text, payloadJson: null, drops: ["unparsed_response"], flags: truncated ? ["body_truncated"] : [] });
        expect(ledger.finalize(finalizeEmpty)[0]).toMatchObject({ payloadText: text, disposition: "unparsed_response", flags: truncated ? ["body_truncated"] : [] });
      });
    }
  }
});

describe("Monid output capture", () => {
  for (const phase of ["post", "poll", "stop"] as const) {
    it.each(["failed", "provider-error"] as const)(`retains malformed ${phase} output on %s and bills once`, async (failure) => {
      const output = { unexpected: [JOB] };
      const body = completed({ output, billedUnits: 5, ...(failure === "failed"
        ? { status: "FAILED" } : { providerResponse: { httpStatus: 500 } }) });
      const run = async (deliveries: DeliveryRecorder) => {
        const bad = response(200, body);
        const answers = phase === "post" ? [bad] : phase === "poll"
          ? [response(202, responses.accepted), bad]
          : [response(202, responses.accepted), response(200, responses.running), bad];
        const h = await harness(answers, { deliveries, settings: shortSettings() });
        const consume = vi.spyOn(h.ctx.budget, "consume");
        await expect(h.channel.collect(query(), h.ctx)).rejects.toMatchObject({ code: "network" });
        expect(consume).toHaveBeenCalledOnce();
        expect(consume.mock.calls[0]?.[0]).toBe(5);
        return consume.mock.calls;
      };
      const baseline = await run(NO_DELIVERIES);
      const ledger = createDeliveryLedger({});
      expect(await run(ledger)).toEqual(baseline);
      expect(ledger.finalize(finalizeEmpty)).toMatchObject([{ ordinal: 0, disposition: "unparsed_response", payloadJson: output }]);
      expect(ledger.entries()).toHaveLength(1);
    });
  }

  it.each(["poll", "independent-stop"] as const)("retains malformed %s output during cancellation and bills once", async (phase) => {
    const output = { unexpected: [JOB] };
    const ledger = createDeliveryLedger({});
    const reason = new DOMException("Cancelled cycle", "AbortError");
    const h = await harness([
      response(202, responses.accepted),
      ...(phase === "poll" ? [() => {
        const result = response(200, completed({ status: "RUNNING", output, billedUnits: 5 }));
        return { ...result, text: async () => { const text = await result.text(); h.controller.abort(reason); return text; } };
      }] : []),
      response(200, completed({ output: phase === "independent-stop" ? output : [], billedUnits: 5 })),
    ], {
      deliveries: ledger,
      ...(phase === "independent-stop" ? { sleep: async () => { h.controller.abort(reason); throw reason; } } : {}),
    });
    const consume = vi.spyOn(h.ctx.budget, "consume");
    await expect(h.channel.collect(query(), h.ctx)).rejects.toBe(reason);
    expect(h.requests.at(-1)?.path).toBe("/v1/runs/run_example/stop");
    expect(consume).toHaveBeenCalledOnce();
    expect(consume.mock.calls[0]?.[0]).toBe(5);
    expect(ledger.entries()).toHaveLength(1);
    expect(ledger.finalize(finalizeEmpty)).toMatchObject([{ disposition: "unparsed_response", payloadJson: output }]);
  });

  it("retains FAILED output even though collection throws", async () => {
    const ledger = createDeliveryLedger({});
    const h = await harness([response(200, completed({ status: "FAILED", output: [JOB] }))], { deliveries: ledger });
    await expect(h.channel.collect(query(), h.ctx)).rejects.toMatchObject({ code: "network" });
    expect(ledger.entries()).toMatchObject([{ ordinal: 0, batch: 1, payloadJson: JOB }]);
    expect(ledger.finalize(finalizeEmpty)).toMatchObject([{ disposition: "discarded_on_failure", payloadJson: JOB }]);
  });

  it("retains poll output when the fake poll cancels the signal after the body arrives", async () => {
    const ledger = createDeliveryLedger({});
    const reason = new DOMException("Cancelled cycle", "AbortError");
    const h = await harness([
      response(202, responses.accepted),
      () => {
        const result = response(200, completed({ status: "RUNNING", output: [JOB] }));
        return { ...result, text: async () => { const text = await result.text(); h.controller.abort(reason); return text; } };
      },
      response(200, completed({ output: [] })),
    ], { deliveries: ledger });
    await expect(h.channel.collect(query(), h.ctx)).rejects.toBe(reason);
    expect(h.requests.map((request) => request.path)).toEqual(["/v1/run", "/v1/runs/run_example", "/v1/runs/run_example/stop"]);
    expect(ledger.entries()).toMatchObject([{ ordinal: 0, batch: 1, payloadJson: JOB }]);
    expect(ledger.finalize(finalizeEmpty)).toMatchObject([{ disposition: "discarded_on_failure", payloadJson: JOB }]);
  });

  it("captures output from a timeout stop and returns its ordinal", async () => {
    const ledger = createDeliveryLedger({});
    const h = await harness([response(202, responses.accepted), response(200, responses.running), response(200, completed({ output: [JOB] }))], { deliveries: ledger, settings: shortSettings() });
    const postings = await h.channel.collect(query(), h.ctx);
    expect(h.requests.at(-1)?.path).toBe("/v1/runs/run_example/stop");
    expect(postings).toMatchObject([{ payload: JOB, deliveryOrdinal: 0 }]);
    expect(ledger.entries()).toMatchObject([{ ordinal: 0, batch: 1, payloadJson: JOB }]);
  });

  it("captures output from an independent cancellation stop", async () => {
    const ledger = createDeliveryLedger({});
    const reason = new DOMException("Cancelled cycle", "AbortError");
    const h = await harness([response(202, responses.accepted), response(200, completed({ output: [JOB] }))], {
      deliveries: ledger, sleep: async () => { h.controller.abort(reason); throw reason; },
    });
    await expect(h.channel.collect(query(), h.ctx)).rejects.toBe(reason);
    expect(h.requests.map((request) => request.path)).toEqual(["/v1/run", "/v1/runs/run_example/stop"]);
    expect(ledger.finalize(finalizeEmpty)).toMatchObject([{ disposition: "discarded_on_failure", payloadJson: JOB }]);
  });

  it("retains wrong-shaped output as one unparsed JSON item", async () => {
    const output = { unexpected: [JOB] };
    const ledger = createDeliveryLedger({});
    const h = await harness([response(200, completed({ output }))], { deliveries: ledger });
    await expect(h.channel.collect(query(), h.ctx)).rejects.toMatchObject({ code: "parse" });
    expect(ledger.entries()).toMatchObject([{ ordinal: 0, payloadJson: output, payloadText: null, drops: ["unparsed_response"] }]);
    expect(ledger.finalize(finalizeEmpty)).toMatchObject([{ disposition: "unparsed_response", payloadJson: output }]);
  });

  it("reuses receipt ordinals when poll and finish observe the same output", async () => {
    const ledger = createDeliveryLedger({});
    const h = await harness([response(202, responses.accepted), response(200, completed({ status: "RUNNING", output: [JOB, JOB] })), response(200, completed({ output: [JOB, JOB] }))], { deliveries: ledger });
    const postings = await h.channel.collect(query(), h.ctx);
    expect(postings.map((posting) => posting.deliveryOrdinal)).toEqual([0]);
    expect(ledger.entries()).toHaveLength(2);
    expect(ledger.entries().map((entry) => entry.ordinal)).toEqual([0, 1]);
    expect(ledger.finalize(finalizeEmpty).map((entry) => entry.disposition)).toEqual(["discarded_on_failure", "duplicate_in_run"]);
  });

  it("returns aligned client ordinals while billing five units for one delivered item", async () => {
    const ledger = createDeliveryLedger({});
    const h = await harness([response(200, completed({ output: [JOB], billedUnits: 5, cost: { value: 0.006, currency: "USD" } }))], { deliveries: ledger });
    const consume = vi.spyOn(h.ctx.budget, "consume");
    const client = new MonidClient({ ctx: h.ctx, apiKey: FAKE_KEY, settings: settings() });
    const result = await client.run({ jobTitles: ["Platform Engineer"], locations: ["Example City"], maxItems: 10 }, 10);
    expect(consume).toHaveBeenCalledExactlyOnceWith(5, { costUsd: 0.006, allowOverspend: true });
    expect(result).toEqual({ items: [JOB], ordinals: [0] });
    expect(ledger.entries()).toHaveLength(1);
    expect(ledger.entries()[0]?.payloadJson).toEqual(JOB);
  });
});

describe("Monid channel dispositions", () => {
  it("quarantines an unidentified old record with its ordinal and date evidence", async () => {
    const item = { title: "Unidentified role", postedDate: "2020-01-01" };
    const ledger = createDeliveryLedger({});
    const h = await harness([response(200, completed({ output: [item] }))], { deliveries: ledger });
    const postings = await h.channel.collect(query({ windowHours: 10 }), h.ctx);
    expect(postings).toMatchObject([{ deliveryOrdinal: 0, payload: item, externalId: expect.stringMatching(/^unidentified:/) }]);
    expect(ledger.entries()).toMatchObject([{ ordinal: 0, payloadJson: item, drops: [], flags: ["unidentified", "date_day_precision"] }]);
    const externalId = postings[0]?.externalId;
    expect(externalId).toBeTypeOf("string");
    if (externalId === undefined) throw new Error("Expected quarantined posting");
    expect(ledger.finalize({ ...finalizeEmpty, stored: new Map([[0, externalId]]) })[0]).toMatchObject({ disposition: "stored", flags: ["unidentified", "date_day_precision"] });
  });

  it.each([
    { name: "provider error", items: [{ error: "Example failure" }], disposition: "provider_error", externalId: null, flags: [] },
    { name: "duplicate", items: [JOB, JOB], disposition: "duplicate_in_run", externalId: JOB.id, flags: [] },
    { name: "outside window", items: [{ ...JOB, postedDate: "2026-10-24" }], disposition: "outside_window", externalId: JOB.id, flags: ["date_day_precision"] },
  ])("records $name with identity and date evidence", async ({ items, disposition, externalId, flags }) => {
    const ledger = createDeliveryLedger({});
    const h = await harness([response(200, completed({ output: items }))], { deliveries: ledger });
    const postings = await h.channel.collect(query({ windowHours: 10 }), h.ctx);
    const ordinal = items.length - 1;
    expect(ledger.entries()).toHaveLength(items.length);
    expect(ledger.entries()[ordinal]).toMatchObject({ ordinal, payloadJson: items[ordinal], drops: [disposition], externalId, flags });
    expect(ledger.finalize(finalizeEmpty)[ordinal]).toMatchObject({ disposition, externalId, flags });
    expect(postings.map((posting) => posting.deliveryOrdinal)).toEqual(disposition === "duplicate_in_run" ? [0] : []);
  });

  it.each([10, 24])("reports the actual cutoff for a %i-hour query", async (windowHours) => {
    const ledger = createDeliveryLedger({});
    const cutoff = vi.spyOn(ledger, "setWindowCutoff");
    const h = await harness([response(200, completed())], { deliveries: ledger });
    await h.channel.collect(query({ windowHours }), h.ctx);
    const expected = windowHours === 10 ? NOW.getTime() - 10 * 3_600_000 : null;
    expect(cutoff).toHaveBeenCalledExactlyOnceWith(expected);
    expect(ledger.windowCutoff()).toBe(expected);
  });
});

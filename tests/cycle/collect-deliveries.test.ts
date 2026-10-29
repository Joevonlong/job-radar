// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BudgetTracker } from "@/lib/channels/budget";
import { CircuitBreaker } from "@/lib/channels/circuit";
import { NO_KNOWN_POSTINGS } from "@/lib/channels/context";
import { NO_DELIVERIES } from "@/lib/channels/delivery";
import { BudgetExceededError, ChannelError, PartialCollectError } from "@/lib/channels/errors";
import { createLogger, type LogRecord } from "@/lib/channels/logger";
import { ChannelRegistry } from "@/lib/channels/registry";
import { createMemoryStateStore } from "@/lib/channels/store";
import type { Channel, ChannelContext, RawPostingInput } from "@/lib/channels/types";
import * as configuration from "@/lib/config";
import { collectStep, type CollectResult } from "@/lib/cycle/collect";
import type { CycleStepContext } from "@/lib/cycle/steps";
import type { Db } from "@/lib/db/client";
import * as deliveries from "@/lib/db/repos/deliveries";
import * as rawPostings from "@/lib/db/repos/raw-postings";
import * as runs from "@/lib/db/repos/runs";

import { fakeRecorder } from "../activity/helpers";

import { config, probeChannel, settings } from "./helpers";

const now = new Date("2026-10-07T08:00:00Z");
const db = {} as Db;
const posting = (id: string): RawPostingInput => ({ externalId: id, url: null, payload: { id } });
const stored = { inserted: 1, changed: 0, unchanged: 0 };

function auditConfig(): configuration.DeliveryAuditConfig {
  return {
    scope: { channel_kinds: ["paid"], exclude_channels: [] },
    checkpoint: { write_timeout_ms: 1000 },
    retention: { days: 1, warn_bytes: 1024 },
    prune: { every_minutes: 1, batch_size: 10, statement_timeout_ms: 50 },
  };
}

function receive(ctx: ChannelContext, records: RawPostingInput[]): RawPostingInput[] {
  const ordinals = ctx.deliveries.received({ batch: ctx.deliveries.beginBatch(), items: records.map((record) => record.payload) });
  return records.map((record, index) => ({ ...record, deliveryOrdinal: ordinals[index] }));
}

beforeEach(() => {
  vi.spyOn(configuration, "loadConfig").mockReturnValue(auditConfig());
  vi.spyOn(deliveries, "deliveryTablesReady").mockResolvedValue(true);
  vi.spyOn(deliveries, "insertDeliveryCheckpoint").mockResolvedValue();
  vi.spyOn(deliveries, "finishRunWithDeliveries").mockResolvedValue({ upsert: stored, counts: { dispositions: {}, flags: {} }, mismatch: [] });
  vi.spyOn(rawPostings, "upsertRawPostings").mockResolvedValue(stored);
  vi.spyOn(runs, "getQueryRunHistory").mockResolvedValue([]);
  vi.spyOn(runs, "createRun").mockImplementation(async (_db, input) => ({
    id: 1, cycleId: input.cycleId ?? null, channelId: input.channelId, queryHash: input.queryHash ?? null,
    startedAt: now, finishedAt: null, status: "running", fetched: 0, newCount: 0, cost: 0,
    error: null, errorCode: null, interrupted: false, usageUnits: 0,
    windowHours: input.windowHours ?? null, windowExtended: input.windowExtended ?? false,
  }));
  vi.spyOn(runs, "finishRun").mockResolvedValue(null);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function setup(collect: Channel["collect"], kind: Channel["kind"] = "paid", usesQueries = false) {
  const cfg = config();
  const registry = new ChannelRegistry();
  registry.register({ ...probeChannel("receipts", { usesQueries }), kind, collect }, { settings: settings() });
  const store = createMemoryStateStore();
  const logs: LogRecord[] = [];
  const context: CycleStepContext = {
    cycle: { id: 1, kind: "manual" }, windowKind: null, dryRun: false, db, signal: new AbortController().signal,
    logger: createLogger({ sink: (record) => logs.push(record) }), now: () => now, config: cfg, results: {},
    channels: {
      registry, store, known: () => NO_KNOWN_POSTINGS, selected: null, cascades: [],
      breaker: new CircuitBreaker(store, () => ({ failures: 3, cooldownMs: 60_000 }), () => now),
      budget: await BudgetTracker.create({ store, month: "2026-10", globalCapUsd: 100, settingsFor: (id) => registry.settingsFor(id, cfg.channels) }),
      runtime: { sleep: async () => {} },
    },
  };
  return { context, logs, run: async () => (await collectStep(context)).result as CollectResult };
}

function finalWrite() {
  expect(deliveries.finishRunWithDeliveries).toHaveBeenCalledOnce();
  return vi.mocked(deliveries.finishRunWithDeliveries).mock.calls[0]![1];
}

describe("collect delivery transactions", () => {
  it("waits for checkpoints and commits before reporting success to the breaker", async () => {
    const checkpoint = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<Awaited<ReturnType<typeof deliveries.finishRunWithDeliveries>>>();
    vi.mocked(deliveries.insertDeliveryCheckpoint).mockReturnValue(checkpoint.promise);
    vi.mocked(deliveries.finishRunWithDeliveries).mockReturnValue(commit.promise);
    const test = await setup(async (_query, ctx) => {
      await ctx.budget.consume(5);
      const records = receive(ctx, [posting("kept"), posting("dropped")]);
      ctx.deliveries.drop(records[1]!.deliveryOrdinal!, "outside_window", { externalId: "dropped" });
      ctx.deliveries.setWindowCutoff(now.getTime());
      return [records[0]!];
    });
    const success = vi.spyOn(test.context.channels.breaker, "recordSuccess");
    const running = test.run();
    await vi.waitFor(() => expect(deliveries.insertDeliveryCheckpoint).toHaveBeenCalledOnce());
    expect(deliveries.finishRunWithDeliveries).not.toHaveBeenCalled();
    checkpoint.resolve();
    await vi.waitFor(() => expect(deliveries.finishRunWithDeliveries).toHaveBeenCalledOnce());
    expect(success).not.toHaveBeenCalled();
    const input = finalWrite();
    expect(input).toMatchObject({ ledger: "client", expected: { delivered: 2 }, windowCutoffAt: now, run: { status: "succeeded", fetched: 1, usageUnits: 5 } });
    expect(input.run.newCount).toBeUndefined(); // Derived from the upsert inside the final transaction.
    expect(input.items.map((item) => item.disposition)).toEqual(["stored", "outside_window"]);
    commit.resolve({ upsert: stored, counts: { dispositions: {}, flags: {} }, mismatch: [] });
    expect((await running).channels.receipts).toMatchObject({ succeeded: 1, fetched: 1, inserted: 1 });
    expect(success).toHaveBeenCalledOnce();
    expect(rawPostings.upsertRawPostings).not.toHaveBeenCalled();
    expect(runs.finishRun).not.toHaveBeenCalled();
  });

  it("registers missing ordinals in one batch and retains invalid shapes before schema stripping", async () => {
    const test = await setup(async (_query, ctx) => {
      const recorded = receive(ctx, [posting("")]);
      return [...recorded, posting("kept"), posting("")];
    });
    expect((await test.run()).channels.receipts).toMatchObject({ fetched: 3, succeeded: 1, errorCodes: { parse: 2 } });
    const input = finalWrite();
    expect(input.ledger).toBe("client");
    expect(input.items.map((item) => [item.ordinal, item.batch, item.disposition])).toEqual([
      [0, 1, "invalid_shape"], [1, 2, "stored"], [2, 2, "invalid_shape"],
    ]);
    expect(input.run).toMatchObject({ status: "partial", errorCode: "parse", fetched: 3, error: "2 of 3 records rejected (invalid shape)" });
  });

  it("identifies a channel without receipt instrumentation as collect-owned", async () => {
    await (await setup(async () => [posting("kept")])).run();
    expect(finalWrite()).toMatchObject({ ledger: "collect", items: [{ ordinal: 0, disposition: "stored", externalId: "kept", payloadJson: { id: "kept" } }] });
  });

  it.each([false, true])("stores earlier pages and preserves interruption semantics (planned: %s)", async (planned) => {
    const cause = new ChannelError(planned ? "budget_exceeded" : "network", "next page stopped");
    const test = await setup(async (_query, ctx) => {
      const records = receive(ctx, [posting("kept"), posting("abandoned")]);
      throw new PartialCollectError([records[0]!], cause, { planned });
    });
    const failure = vi.spyOn(test.context.channels.breaker, "recordFailure");
    const result = await test.run();
    expect(finalWrite().items.map((item) => item.disposition)).toEqual(["stored", "discarded_on_failure"]);
    expect(finalWrite().run).toMatchObject({ status: planned ? "skipped" : "partial", errorCode: cause.code, ...(planned ? {} : { interrupted: true }) });
    expect(result.channels.receipts).toMatchObject({ inserted: 1, interrupted: planned ? 0 : 1, skipped: planned ? 2 : 0 });
    expect(failure).toHaveBeenCalledTimes(planned ? 0 : 1);
  });

  it.each(["error", "timeout"] as const)("falls back to closing the run when failure auditing ends in %s", async (mode) => {
    const original = new ChannelError("network", "original channel failure");
    if (mode === "error") vi.mocked(deliveries.finishRunWithDeliveries).mockRejectedValue(new Error("audit unavailable"));
    else vi.mocked(deliveries.finishRunWithDeliveries).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      throw new Error("database statement timeout rolled back the transaction");
    });
    const test = await setup(async (_query, ctx) => {
      await ctx.budget.consume(1);
      receive(ctx, [posting("discarded")]);
      throw original;
    });
    const failure = vi.spyOn(test.context.channels.breaker, "recordFailure");
    if (mode === "timeout") vi.useFakeTimers();
    const running = test.run();
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(1001);
    const result = await running;
    expect(finalWrite()).toMatchObject({ run: { error: original.message, errorCode: "network", usageUnits: 1 }, items: [{ disposition: "discarded_on_failure" }] });
    expect(finalWrite().writeTimeoutMs).toBe(1000);
    expect(runs.finishRun).toHaveBeenCalledWith(db, 1, expect.objectContaining({ status: "failed", error: original.message }), 1000);
    expect(failure).toHaveBeenCalledWith("receipts", "network", { trips: false });
    expect(result.errors).toEqual([]);
    expect(test.logs.some((log) => log.message === "delivery finalization failed; closing run without audit")).toBe(true);
  });

  it("closes a cancelled attempt with its original fields even if the ledger and fallback writes fail", async () => {
    const controller = new AbortController();
    vi.mocked(deliveries.finishRunWithDeliveries).mockRejectedValue(new Error("audit unavailable"));
    vi.mocked(runs.finishRun).mockRejectedValue(new Error("run unavailable"));
    const original = new DOMException("cancelled by test", "AbortError");
    const test = await setup(async (_query, ctx) => {
      receive(ctx, [posting("cancelled")]);
      controller.abort(original);
      throw original;
    });
    test.context.signal = controller.signal;
    expect(await test.run()).toMatchObject({ aborted: true, errors: [] });
    expect(finalWrite()).toMatchObject({ run: { status: "failed", error: "cancelled" }, items: [{ disposition: "discarded_on_failure" }] });
    expect(finalWrite().raw).toBeUndefined();
  });

  it("records an empty delivery summary for a pre-request budget refusal", async () => {
    const test = await setup(async () => { throw new BudgetExceededError("channel", "refused"); });
    await test.run();
    expect(finalWrite()).toMatchObject({ expected: { delivered: 0 }, items: [], run: { status: "skipped", errorCode: "budget_exceeded", usageUnits: 0 } });
    expect(deliveries.insertDeliveryCheckpoint).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves the storage InfrastructureError after store_failed finalization (audit fails: %s)", async (auditFails) => {
    vi.mocked(deliveries.finishRunWithDeliveries).mockRejectedValueOnce(new Error("raw unavailable"));
    if (auditFails) vi.mocked(deliveries.finishRunWithDeliveries).mockRejectedValueOnce(new Error("audit unavailable"));
    const test = await setup(async (_query, ctx) => receive(ctx, [posting("kept")]));
    const failure = vi.spyOn(test.context.channels.breaker, "recordFailure");
    const result = await test.run();
    expect(deliveries.finishRunWithDeliveries).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deliveries.finishRunWithDeliveries).mock.calls[1]![1]).toMatchObject({
      run: { status: "failed", fetched: 1, error: "could not store postings", errorCode: "unknown" },
      items: [{ disposition: "store_failed", externalId: "kept", payloadJson: { id: "kept" } }],
    });
    expect(vi.mocked(deliveries.finishRunWithDeliveries).mock.calls[1]![1].raw).toBeUndefined();
    expect(result.errors).toEqual(["receipts: InfrastructureError: could not store postings of receipts"]);
    expect(failure).not.toHaveBeenCalled();
    expect(runs.finishRun).toHaveBeenCalledTimes(auditFails ? 1 : 0);
  });

  it("includes unconfirmed payloads in the final transaction after a checkpoint error", async () => {
    vi.mocked(deliveries.insertDeliveryCheckpoint).mockRejectedValue(new Error("private failed statement"));
    const test = await setup(async (_query, ctx) => receive(ctx, [posting("kept")]));
    await test.run();
    expect(finalWrite().items).toMatchObject([{ disposition: "stored", confirmed: false, payloadJson: { id: "kept" } }]);
    expect(test.logs.some((log) => log.message === "delivery checkpoint could not be written")).toBe(true);
    expect(JSON.stringify(test.logs)).not.toContain("private failed statement");
  });

  it("logs reconciliation codes without received payloads or external ids", async () => {
    vi.mocked(deliveries.finishRunWithDeliveries).mockResolvedValue({ upsert: stored, counts: { dispositions: {}, flags: {} }, mismatch: ["stored_count"] });
    const test = await setup(async () => [posting("private-external-id")]);
    await test.run();
    const warning = test.logs.find((log) => log.message === "delivery reconciliation mismatch");
    expect(warning?.fields).toEqual({ channel: "receipts", runId: 1, mismatch: ["stored_count"] });
    expect(JSON.stringify(test.logs)).not.toContain("private-external-id");
  });
});

describe("delivery audit compatibility", () => {
  it.each(["kind", "excluded", "not-ready", "readiness-error", "config-error", "dry-run"] as const)("uses the original path for %s", async (mode) => {
    const test = await setup(async (_query, ctx) => {
      expect(ctx.deliveries).toBe(NO_DELIVERIES);
      return [posting("kept")];
    }, mode === "kind" ? "api" : "paid");
    if (mode === "excluded") vi.mocked(configuration.loadConfig).mockReturnValue({ ...auditConfig(), scope: { channel_kinds: ["paid"], exclude_channels: ["receipts"] } });
    if (mode === "not-ready") vi.mocked(deliveries.deliveryTablesReady).mockResolvedValue(false);
    if (mode === "readiness-error") vi.mocked(deliveries.deliveryTablesReady).mockRejectedValue(new Error("read failed"));
    if (mode === "config-error") vi.mocked(configuration.loadConfig).mockImplementation(() => { throw new Error("invalid config"); });
    if (mode === "dry-run") { test.context.dryRun = true; test.context.db = null; }
    const result = await test.run();
    expect(deliveries.finishRunWithDeliveries).not.toHaveBeenCalled();
    expect(deliveries.insertDeliveryCheckpoint).not.toHaveBeenCalled();
    expect(result.channels.receipts).toMatchObject({ fetched: 1, succeeded: 1 });
    expect(configuration.loadConfig).toHaveBeenCalledExactlyOnceWith("deliveryAudit");
    expect(result.errors).toEqual([]);
    if (mode === "dry-run") {
      expect(rawPostings.upsertRawPostings).not.toHaveBeenCalled();
      expect(runs.createRun).not.toHaveBeenCalled();
    } else {
      expect(rawPostings.upsertRawPostings).toHaveBeenCalledOnce();
      expect(runs.finishRun).toHaveBeenCalledWith(db, 1, expect.objectContaining({ status: "succeeded", fetched: 1, newCount: 1 }));
    }
    if (mode === "not-ready" || mode === "readiness-error" || mode === "config-error") expect(test.logs.filter((log) => log.level === "warn")).toHaveLength(1);
  });

  it("loads configuration and checks table readiness once across parallel units", async () => {
    const test = await setup(async () => [posting("kept")]);
    test.context.channels.registry.register({ ...probeChannel("another", { usesQueries: false }), kind: "paid" }, { settings: settings() });
    await test.run();
    expect(configuration.loadConfig).toHaveBeenCalledExactlyOnceWith("deliveryAudit");
    expect(deliveries.deliveryTablesReady).toHaveBeenCalledExactlyOnceWith(db);
    expect(deliveries.finishRunWithDeliveries).toHaveBeenCalledTimes(2);
  });
});


describe("collection activity", () => {
  it.each(["ok", "partial", "failed", "skipped", "aborted", "store_failed"] as const)("observes the %s delivery outcome without changing finalization", async (mode) => {
    const fake = fakeRecorder();
    const controller = new AbortController();
    const test = await setup(async () => {
      if (mode === "failed") throw new ChannelError("network", "private");
      if (mode === "aborted") { controller.abort(); throw new DOMException("private", "AbortError"); }
      if (mode === "skipped") throw new PartialCollectError([posting("kept")], new ChannelError("budget_exceeded", "private"), { planned: true });
      return [posting(mode === "partial" ? "" : "kept")];
    });
    if (mode === "store_failed") vi.mocked(deliveries.finishRunWithDeliveries).mockRejectedValueOnce(new Error("private"));
    test.context.signal = controller.signal;
    test.context.activity = fake.recorder.cycleRoot(1).child("step.collect");
    await test.run();
    const span = fake.spans.find((s) => s.name === "collect.query" && s.links.runId === 1);
    expect(span?.links).toMatchObject({ runId: 1, channelId: "receipts", queryId: expect.any(String) });
    expect(span?.finishes).toEqual([[mode === "ok" ? "ok" : mode === "partial" ? "partial" : mode === "skipped" ? "skipped" : "failed",
      mode === "ok" ? undefined : { reasonCode: mode === "partial" ? "parse" : mode === "skipped" ? "budget_exceeded" : mode === "aborted" ? "aborted" : mode === "store_failed" ? "unknown" : "network" }]]);
    expect(fake.spans.filter((s) => s.name === "collect.query").every((s) => s.finishes.length === 1)).toBe(true);
  });

  it.each(["none", "create", "finish"] as const)("records every cascade skip despite a %s write failure", async (writeFailure) => {
    const fake = fakeRecorder();
    const test = await setup(async () => { throw new Error("must not collect"); }, "paid", true);
    vi.spyOn(test.context.channels.breaker, "check").mockResolvedValue({ allowed: false, state: "open", openUntil: new Date(now.getTime() + 60000) });
    if (writeFailure === "create") vi.mocked(runs.createRun).mockRejectedValue(new Error("private"));
    if (writeFailure === "finish") vi.mocked(runs.finishRun).mockRejectedValue(new Error("private"));
    test.context.activity = fake.recorder.cycleRoot(1).child("step.collect");
    const result = await test.run();
    const spans = fake.spans.filter((s) => s.name === "collect.query");
    expect(spans).toHaveLength(result.queries);
    expect(spans.length).toBeGreaterThan(1);
    expect(spans.map((s) => s.links.runId)).toEqual(spans.map((_, index) => writeFailure !== "create" && index === 0 ? 1 : undefined));
    expect(spans.every((s) => s.notes[0]?.[1] === "cascade_reasons" && s.notes[0]?.[2]?.receipts === "circuit_open")).toBe(true);
    expect(spans.every((s) => s.finishes.length === 1 && s.finishes[0]?.[0] === "skipped" && s.finishes[0]?.[1]?.reasonCode === "circuit_open")).toBe(true);
    expect(runs.createRun).toHaveBeenCalledOnce();
    const step = fake.spans.find((s) => s.name === "step.collect");
    expect(step?.progress).toEqual([[0, spans.length], [spans.length, spans.length]]);
    expect(result.errors.length).toBe(writeFailure !== "none" ? 1 : 0);
  });
});

import fs from "node:fs";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { deliveryCountsSchema } from "@/lib/channels/delivery";
import { BudgetExceededError, ChannelError, PartialCollectError } from "@/lib/channels/errors";
import { createApifyChannel } from "@/lib/channels/linkedin/apify";
import { ChannelRegistry } from "@/lib/channels/registry";
import type { Channel } from "@/lib/channels/types";
import { resetConfigCache } from "@/lib/config";
import { runCycle, type RunCycleOptions } from "@/lib/cycle/run-cycle";
import { CYCLE_STEP_NAMES, registerCycleStep, resetCycleSteps } from "@/lib/cycle/steps";
import { closeDb, getClosureOverride, getDb, getJobDetail, listRawPostingsForChannel, listRunsForCycle, schema, setClosureOverride } from "@/lib/db";
import { createConnection } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { upsertChannelRows } from "@/lib/db/repos/channels";
import { getOrCreateCompany } from "@/lib/db/repos/companies";
import { resetDeliveryTablesCache } from "@/lib/db/repos/deliveries";
import { insertJob, touchJobsSeen } from "@/lib/db/repos/jobs";
import { upsertJobSource } from "@/lib/db/repos/job-sources";
import { upsertRawPostings } from "@/lib/db/repos/raw-postings";
import type { Run } from "@/lib/db/repos/runs";

import { channelsWith } from "../channels/helpers";
import { ENV, fakeApify, response } from "../channels/linkedin/apify/helpers";
import type { TempConfig } from "../config/helpers";
import { collectOf, quietLogger } from "../cycle/helpers";
import { auditConfig, CHANNEL, CUTOFF, cycleConfig, NOW, paidChannel, paidSettings, posting, receive, UNIT_USD, writeAuditConfig } from "./fixtures/collect-deliveries-helpers";

const url = inject("testDatabaseUrl");
let temp: TempConfig;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});
beforeEach(async () => {
  temp = auditConfig();
  resetDeliveryTablesCache();
  resetCycleSteps();
  // Exercise collect and its real database writes without unrelated downstream work.
  for (const name of CYCLE_STEP_NAMES) if (name !== "collect") registerCycleStep(name, async () => {});
  await getDb().execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels restart identity cascade`);
});
afterEach(() => { resetCycleSteps(); temp.cleanup(); });
afterAll(() => closeDb());

function run(channel: Channel, options: RunCycleOptions = {}) {
  const registry = new ChannelRegistry();
  registry.register(channel, { settings: paidSettings() });
  return runCycle("manual", {
    registry, config: cycleConfig(), cascades: [], logger: quietLogger,
    sleep: async () => {}, now: () => NOW, ...options,
  });
}

async function runsOf(result: Awaited<ReturnType<typeof run>>) {
  expect(result.cycleId).not.toBeNull();
  return listRunsForCycle(getDb(), result.cycleId!);
}

async function onlyRun(result: Awaited<ReturnType<typeof run>>): Promise<Run> {
  const runs = await runsOf(result);
  expect(runs).toHaveLength(1);
  return runs[0]!;
}

async function audit(run: Run) {
  const summaries = await getDb().select().from(schema.runDeliveries).where(eq(schema.runDeliveries.runId, run.id));
  expect(summaries).toHaveLength(1);
  const summary = summaries[0]!;
  const items = await getDb().select().from(schema.deliveryItems).where(eq(schema.deliveryItems.runId, run.id)).orderBy(schema.deliveryItems.ordinal);
  const counts = deliveryCountsSchema.parse(summary.countsJson);
  expect(summary.channelId).toBe(run.channelId);
  expect(summary.billedUnits).toBe(run.usageUnits);
  expect(summary.delivered).toBe(items.length);
  expect(items.map((item) => item.ordinal)).toEqual(items.map((_, index) => index));
  expect(items.every((item) => item.disposition !== "received_uncommitted")).toBe(true);
  expect(Object.values(counts.dispositions).reduce((sum, n) => sum + n, 0)).toBe(summary.delivered);
  expect(counts.mismatch ?? []).toEqual([]);
  const actual: Record<string, number> = {};
  for (const item of items) actual[item.disposition] = (actual[item.disposition] ?? 0) + 1;
  expect(counts.dispositions).toEqual(actual);
  for (const item of items) {
    expect(item.channelId).toBe(run.channelId);
    if (item.disposition === "stored") {
      expect(item.rawPostingId).not.toBeNull();
      expect(item.payloadJson).toBeNull();
      expect(item.payloadText).toBeNull();
      const [raw] = await getDb().select().from(schema.rawPostings).where(eq(schema.rawPostings.id, item.rawPostingId!));
      expect(raw).toMatchObject({ channelId: run.channelId, externalId: item.externalId });
    } else {
      expect(item.rawPostingId).toBeNull();
      expect(item.payloadJson !== null || item.payloadText !== null).toBe(true);
    }
  }
  return { summary, items, counts };
}

describe("collect delivery persistence", () => {
  it.each(["summary", "run"] as const)("bounds failure finalization and fallback while the %s is locked", async (locked) => {
    const blocker = createConnection(url, { max: 1 });
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let holding: Promise<void> | undefined;
    const result = run(paidChannel(async (_query, ctx) => {
      await ctx.budget.consume(5);
      receive(ctx, [posting("locked-receipt")]);
      holding = blocker.db.transaction(async (tx) => {
        if (locked === "summary") await tx.execute(sql`lock table run_deliveries in access exclusive mode`);
        else await tx.execute(sql`select id from runs where status = 'running' for no key update`);
        ready.resolve();
        await release.promise;
      });
      await ready.promise;
      throw new ChannelError("network", "original paid channel failure");
    }));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const completed = await Promise.race([
        result.then(() => true),
        new Promise<false>((resolve) => { deadline = setTimeout(() => resolve(false), 4000); }),
      ]);
      expect(completed, "collect must return while the external lock is still held").toBe(true);
    } finally {
      clearTimeout(deadline);
      release.resolve();
      await holding;
      await blocker.sql.end();
      await result;
    }
    const runRow = await onlyRun(await result);
    // The summary lock occurs after the ledger transaction updated runs: its rollback must
    // release that row before the standalone fallback can close it. A run lock blocks both writes.
    expect(runRow).toMatchObject(locked === "summary"
      ? { status: "failed", errorCode: "network", error: "original paid channel failure", usageUnits: 5 }
      : { status: "running", usageUnits: 0, finishedAt: null });
    expect(await getDb().select().from(schema.runDeliveries)).toHaveLength(0);
    expect((await getDb().select().from(schema.deliveryItems))[0]).toMatchObject({
      disposition: "received_uncommitted", payloadJson: { id: "locked-receipt" },
    });
    const [state] = await getDb().select().from(schema.channels).where(eq(schema.channels.id, CHANNEL));
    expect(state?.monthUsage).toMatchObject({ "2026-10": { records: 5, usd: 5 * UNIT_USD } });
  });

  it("keeps collect and cycle status identical to the no-ledger outcome when audit configuration is invalid", async () => {
    const channel = paidChannel(async (_query, ctx) => {
      await ctx.budget.consume(1);
      return receive(ctx, [posting("compatible")]);
    });
    writeAuditConfig(temp, [CHANNEL]);
    const baseline = await run(channel);
    fs.writeFileSync(path.join(temp.defaultsDir, "delivery-audit.yaml"), "config_version: 1\n");
    resetConfigCache();
    const result = await run(channel);
    expect(baseline.status).toBe("succeeded");
    expect(result.status).toBe(baseline.status);
    expect(collectOf(result).status).toBe(collectOf(baseline).status);
    expect(result.summary.steps.find((step) => step.name === "collect")?.status).toBe(
      baseline.summary.steps.find((step) => step.name === "collect")?.status,
    );
    expect(collectOf(result).errors).toEqual(collectOf(baseline).errors);
    expect(await onlyRun(result)).toMatchObject({ status: "succeeded", fetched: 1, usageUnits: 1 });
    expect(await getDb().select().from(schema.runDeliveries)).toHaveLength(0);
  });

  it("reconciles successful receipts, billing, stored references, drops, flags and the actual window", async () => {
    const payloads = [{ id: "kept" }, { error: "provider refused" }, { id: "old" }];
    const result = await run(paidChannel(async (_query, ctx) => {
      await ctx.budget.consume(3);
      const records = receive(ctx, [posting("kept", payloads[0]), posting("error", payloads[1]), posting("old", payloads[2])]);
      const [, errorItem, old] = records;
      if (errorItem?.deliveryOrdinal !== undefined) ctx.deliveries.drop(errorItem.deliveryOrdinal, "provider_error");
      if (old?.deliveryOrdinal !== undefined) ctx.deliveries.drop(old.deliveryOrdinal, "outside_window", { externalId: "old" });
      if (records[0]?.deliveryOrdinal !== undefined) ctx.deliveries.flag(records[0].deliveryOrdinal, ["date_missing"]);
      ctx.deliveries.setWindowCutoff(CUTOFF.getTime());
      return [records[0]!];
    }));
    const runRow = await onlyRun(result);
    expect(runRow).toMatchObject({ status: "succeeded", fetched: 1, newCount: 1, usageUnits: 3 });
    expect(Number(runRow.cost)).toBeCloseTo(3 * UNIT_USD, 6);
    const { summary, items, counts } = await audit(runRow);
    expect(summary).toMatchObject({ ledger: "client", delivered: 3, billedUnits: 3, distinctIds: 2, windowCutoffAt: CUTOFF });
    expect(counts).toMatchObject({ dispositions: { stored: 1, provider_error: 1, outside_window: 1 }, flags: { date_missing: 1 } });
    expect(items.map((item) => item.batch)).toEqual([1, 1, 1]);
    expect(items[1]?.payloadJson).toEqual(payloads[1]);
    expect(items[2]?.payloadJson).toEqual(payloads[2]);
    const raw = await listRawPostingsForChannel(getDb(), CHANNEL);
    expect(raw).toHaveLength(runRow.fetched);
    expect(raw[0]).toMatchObject({ externalId: "kept", payloadJson: payloads[0], payloadHash: items[0]!.payloadHash });
  });

  it("allows one delivered item to account for five billed units without a mismatch", async () => {
    const result = await run(paidChannel(async (_query, ctx) => {
      await ctx.budget.consume(5);
      return receive(ctx, [posting("one")]);
    }));
    const runRow = await onlyRun(result);
    expect(runRow).toMatchObject({ status: "succeeded", usageUnits: 5, fetched: 1 });
    expect(Number(runRow.cost)).toBeCloseTo(5 * UNIT_USD, 6);
    expect((await audit(runRow)).summary).toMatchObject({ ledger: "client", billedUnits: 5, delivered: 1 });
  });

  it("registers returned records itself when the paid channel does not report receipts", async () => {
    const result = await run(paidChannel(async (_query, ctx) => {
      await ctx.budget.consume(1);
      return [posting("fallback")];
    }));
    const runRow = await onlyRun(result);
    expect(runRow).toMatchObject({ status: "succeeded", fetched: 1 });
    const { summary, items } = await audit(runRow);
    expect(summary).toMatchObject({ ledger: "collect", delivered: 1, billedUnits: 1, windowCutoffAt: null });
    expect(items[0]).toMatchObject({ externalId: "fallback", disposition: "stored" });
  });

  it("retains invalid returned shapes with their payload and preserves the partial run semantics", async () => {
    const payload = { id: "rejected", description: "verbatim invalid record" };
    const result = await run(paidChannel(async (_query, ctx) => {
      await ctx.budget.consume(2);
      return receive(ctx, [posting("valid"), posting("", payload)]);
    }));
    const runRow = await onlyRun(result);
    expect(runRow).toMatchObject({ status: "partial", errorCode: "parse", interrupted: false, fetched: 2, newCount: 1 });
    expect(runRow.error).toContain("records rejected");
    const { items, counts } = await audit(runRow);
    expect(counts.dispositions).toEqual({ stored: 1, invalid_shape: 1 });
    expect(items[1]).toMatchObject({ disposition: "invalid_shape", payloadJson: payload });
    expect(await listRawPostingsForChannel(getDb(), CHANNEL)).toHaveLength(1);
  });

  it("stores earlier pages of an interruption and discards receipts from the failed batch", async () => {
    const abandoned = { id: "failed-page", body: "received before parsing failed" };
    const result = await run(paidChannel(async (_query, ctx) => {
      await ctx.budget.consume(2);
      const kept = receive(ctx, [posting("kept")]);
      receive(ctx, [posting("failed-page", abandoned)]);
      throw new PartialCollectError(kept, new ChannelError("network", "later page unavailable"));
    }));
    const runRow = await onlyRun(result);
    expect(runRow).toMatchObject({ status: "partial", interrupted: true, errorCode: "network", fetched: 1, newCount: 1, usageUnits: 2 });
    const { items, counts } = await audit(runRow);
    expect(counts.dispositions).toEqual({ stored: 1, discarded_on_failure: 1 });
    expect(items.map((item) => item.batch)).toEqual([1, 2]);
    expect(items[1]).toMatchObject({ disposition: "discarded_on_failure", payloadJson: abandoned });
    expect((await listRawPostingsForChannel(getDb(), CHANNEL)).map((raw) => raw.externalId)).toEqual(["kept"]);
  });

  it("keeps the full received batch when the channel throws and retains its error code", async () => {
    const payloads = [{ id: "first" }, { id: "second" }];
    const result = await run(paidChannel(async (_query, ctx) => {
      await ctx.budget.consume(2);
      receive(ctx, payloads.map((payload) => posting(payload.id, payload)));
      throw new ChannelError("network", "provider disconnected after delivery");
    }));
    const runRow = await onlyRun(result);
    expect(runRow).toMatchObject({ status: "failed", errorCode: "network", error: "provider disconnected after delivery", fetched: 0, usageUnits: 2 });
    const { items } = await audit(runRow);
    expect(items.map((item) => item.disposition)).toEqual(["discarded_on_failure", "discarded_on_failure"]);
    expect(items.map((item) => item.payloadJson)).toEqual(payloads);
    expect(await listRawPostingsForChannel(getDb(), CHANNEL)).toHaveLength(0);
  });

  it("keeps receipts when collect aborts the cycle after receiving a batch", async () => {
    const controller = new AbortController();
    const result = await run(paidChannel(async (_query, ctx) => {
      await ctx.budget.consume(1);
      receive(ctx, [posting("cancelled-receipt")]);
      controller.abort();
      ctx.signal.throwIfAborted();
      return [];
    }), { signal: controller.signal });
    expect(result.summary.aborted).toBe(true);
    const runRow = await onlyRun(result);
    expect(runRow).toMatchObject({ status: "failed", error: "cancelled", errorCode: null, usageUnits: 1 });
    expect((await audit(runRow)).items[0]).toMatchObject({ disposition: "discarded_on_failure", payloadJson: { id: "cancelled-receipt" } });
    expect(await listRawPostingsForChannel(getDb(), CHANNEL)).toHaveLength(0);
  });

  it("records zero deliveries for an attempt refused by budget before making a request", async () => {
    let calls = 0;
    const result = await run(paidChannel(async () => {
      calls += 1;
      throw new BudgetExceededError("channel", "request refused before spending");
    }));
    expect(calls).toBe(1);
    // The following cascade summary is a separate skipped row, not a collect attempt.
    const runs = await runsOf(result);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ status: "skipped", errorCode: "budget_exceeded", error: "request refused before spending", usageUnits: 0 });
    const { summary, items, counts } = await audit(runs[0]!);
    expect(summary).toMatchObject({ delivered: 0, billedUnits: 0, distinctIds: 0 });
    expect(items).toEqual([]);
    expect(counts.dispositions).toEqual({});
    expect(await getDb().select().from(schema.runDeliveries)).toHaveLength(1);
    expect(await listRawPostingsForChannel(getDb(), CHANNEL)).toHaveLength(0);
  });

  it("rolls back raw storage and preserves store_failed payloads when a raw insert trigger rejects the batch", async () => {
    await upsertChannelRows(getDb(), [{ id: CHANNEL, family: "ats", kind: "paid", enabled: true }]);
    await upsertRawPostings(getDb(), { channelId: CHANNEL, runId: null, items: [posting("existing")] });
    const before = await listRawPostingsForChannel(getDb(), CHANNEL);
    await getDb().execute(sql`create function reject_receipt_raw_insert() returns trigger language plpgsql as $$ begin raise exception 'test raw storage unavailable'; end $$`);
    try {
      await getDb().execute(sql`create trigger reject_receipt_raw_insert before insert on raw_postings for each row execute function reject_receipt_raw_insert()`);
      const payloads = [{ id: "new-one" }, { id: "new-two" }];
      const result = await run(paidChannel(async (_query, ctx) => {
        await ctx.budget.consume(2);
        return receive(ctx, payloads.map((payload) => posting(payload.id, payload)));
      }));
      const runRow = await onlyRun(result);
      expect(runRow).toMatchObject({ status: "failed", error: "could not store postings", errorCode: "unknown", fetched: 2, usageUnits: 2 });
      expect(collectOf(result).errors.join(" ")).toContain("could not store postings");
      const { items, counts } = await audit(runRow);
      expect(counts.dispositions).toEqual({ store_failed: 2 });
      expect(items.map((item) => item.payloadJson)).toEqual(payloads);
      expect(await listRawPostingsForChannel(getDb(), CHANNEL)).toEqual(before);
    } finally {
      await getDb().execute(sql`drop trigger if exists reject_receipt_raw_insert on raw_postings`);
      await getDb().execute(sql`drop function reject_receipt_raw_insert()`);
    }
  });

  it("does not duplicate ordinals within either run when the same input and batch observations are replayed", async () => {
    const channel = paidChannel(async (_query, ctx) => {
      await ctx.budget.consume(2);
      const batch = ctx.deliveries.beginBatch();
      const input = [posting("one"), posting("two")];
      receive(ctx, input, batch);
      return receive(ctx, input, batch);
    });
    const first = await onlyRun(await run(channel));
    const second = await onlyRun(await run(channel));
    expect(first.id).not.toBe(second.id);
    expect(first).toMatchObject({ fetched: 2, newCount: 2 });
    expect(second).toMatchObject({ fetched: 2, newCount: 0 });
    for (const runRow of [first, second]) {
      const { summary, items } = await audit(runRow);
      expect(summary).toMatchObject({ delivered: 2, billedUnits: 2, ledger: "client" });
      expect(items.map((item) => item.ordinal)).toEqual([0, 1]);
    }
    expect(await getDb().select().from(schema.runDeliveries)).toHaveLength(2);
    expect(await getDb().select().from(schema.deliveryItems)).toHaveLength(4);
    expect(await listRawPostingsForChannel(getDb(), CHANNEL)).toHaveLength(2);
  });

  it("writes no raw postings or audit rows in a dry run", async () => {
    const result = await run(paidChannel(async (_query, ctx) => {
      await ctx.budget.consume(1);
      return receive(ctx, [posting("dry")]);
    }), { dryRun: true });
    expect(result.cycleId).toBeNull();
    expect(collectOf(result).channels[CHANNEL]?.fetched).toBe(1);
    expect(await getDb().select().from(schema.rawPostings)).toHaveLength(0);
    expect(await getDb().select().from(schema.runs)).toHaveLength(0);
    expect(await getDb().select().from(schema.deliveryItems)).toHaveLength(0);
    expect(await getDb().select().from(schema.runDeliveries)).toHaveLength(0);
  });

  it.each(["api", "excluded"] as const)("leaves audit tables empty for an out-of-scope channel (%s)", async (mode) => {
    if (mode === "excluded") writeAuditConfig(temp, [CHANNEL]);
    const channel = paidChannel(async (_query, ctx) => {
      await ctx.budget.consume(1);
      return receive(ctx, [posting("out-of-scope")]);
    });
    const result = await run(mode === "api" ? { ...channel, kind: "api" } : channel);
    expect(await onlyRun(result)).toMatchObject({ status: "succeeded", fetched: 1 });
    expect(await listRawPostingsForChannel(getDb(), CHANNEL)).toHaveLength(1);
    expect(await getDb().select().from(schema.deliveryItems)).toHaveLength(0);
    expect(await getDb().select().from(schema.runDeliveries)).toHaveLength(0);
  });

  it("does not reopen or refresh a manually closed job whose new receipt is outside the window", async () => {
    const db = getDb();
    const seenAt = new Date("2026-10-01T08:00:00Z");
    await upsertChannelRows(db, [{ id: CHANNEL, family: "ats", kind: "paid", enabled: true }]);
    await upsertRawPostings(db, { channelId: CHANNEL, runId: null, items: [posting("old-job")], fetchedAt: seenAt });
    const [raw] = await listRawPostingsForChannel(db, CHANNEL);
    const company = await getOrCreateCompany(db, { name: "Example", nameNorm: "example" });
    const job = await insertJob(db, { companyId: company.id, title: "Engineer", titleNorm: "engineer", status: "active", firstSeenAt: seenAt, lastSeenAt: seenAt });
    await upsertJobSource(db, { jobId: job.id, rawPostingId: raw!.id, channelId: CHANNEL, url: raw!.url, applyUrl: null, locationLabel: null, priority: 1, firstSeenAt: seenAt });
    await setClosureOverride(db, job.id, "closed", "Manually confirmed", seenAt);
    const before = await getJobDetail(db, job.id);
    expect(before?.status).toBe("closed");
    const result = await run(paidChannel(async (_query, ctx) => {
      await ctx.budget.consume(1);
      const [record] = receive(ctx, [posting("old-job", { id: "old-job", title: "Changed outside the window" })]);
      if (record?.deliveryOrdinal !== undefined) ctx.deliveries.drop(record.deliveryOrdinal, "outside_window", { externalId: "old-job" });
      ctx.deliveries.setWindowCutoff(CUTOFF.getTime());
      return [];
    }));
    const { items } = await audit(await onlyRun(result));
    expect(items[0]).toMatchObject({ disposition: "outside_window", externalId: "old-job" });
    expect(await touchJobsSeen(db, { relistMinGapDays: 9 })).toEqual({ seen: 0, reopened: 0, relisted: 0 });
    expect(await getJobDetail(db, job.id)).toMatchObject({ status: "closed", lastSeenAt: before!.lastSeenAt });
    expect(await getClosureOverride(db, job.id)).toMatchObject({ action: "closed", note: "Manually confirmed" });
    expect(await listRawPostingsForChannel(db, CHANNEL)).toEqual([raw]);
  });

  it("keeps the original delivery hash when the same external id is updated twice later", async () => {
    const attempts: Run[] = [];
    for (const version of [1, 2, 3]) {
      attempts.push(await onlyRun(await run(paidChannel(async (_query, ctx) => {
        await ctx.budget.consume(1);
        return receive(ctx, [posting("changing", { id: "changing", version })]);
      }))));
    }
    const rows = await getDb().execute<{ run_id: string; disposition: string; matches_current: boolean; payload_json: unknown }>(sql`
      select d.run_id::text, d.disposition, d.payload_hash = r.payload_hash as matches_current, d.payload_json
      from delivery_items d join raw_postings r on r.id = d.raw_posting_id
      where d.channel_id = ${CHANNEL} and d.external_id = 'changing' order by d.run_id`);
    expect(rows.map((row) => Number(row.run_id))).toEqual(attempts.map((attempt) => attempt.id));
    expect(rows.map((row) => row.matches_current)).toEqual([false, false, true]);
    expect(rows.map((row) => row.disposition)).toEqual(["stored", "stored", "stored"]);
    expect(rows.map((row) => row.payload_json)).toEqual([null, null, null]);
    for (const attempt of attempts) await audit(attempt);
  });

  it("replays a real Apify channel through collect with a disposition for every delivered actor item", async () => {
    const valid = { id: "4385000001", title: "Engineer", url: "https://www.linkedin.com/jobs/view/4385000001", postedDate: "2026-10-07T07:00:00Z" };
    const payloads = [valid, { error: "page unavailable" }, { title: "Missing identity" }, { ...valid }, { ...valid, id: "4385000002", url: "https://www.linkedin.com/jobs/view/4385000002", postedDate: "2026-10-01T07:00:00Z" }];
    const apify = fakeApify([response(201, payloads)]);
    const registry = new ChannelRegistry();
    registry.register(createApifyChannel({ pricePer1kUsd: () => 0.4, actorId: () => "valig/linkedin-jobs-scraper", environment: ENV, now: () => NOW }));
    const config = cycleConfig();
    config.channels = channelsWith((raw) => {
      raw.paid_total_monthly_budget_usd = 100;
      const block = (raw.linkedin as Record<string, Record<string, unknown>>).apify!;
      Object.assign(block, { enabled: true, price_per_1k_usd: 0.4, run_start_usd: 0.001, monthly_budget_usd: 100, max_results: 10 });
    });
    const result = await runCycle("manual", { registry, config, cascades: [], logger: quietLogger, fetch: apify.fetch, sleep: async () => {}, now: () => NOW });
    expect(apify.requests).toHaveLength(1);
    const runRow = await onlyRun(result);
    // Error items are delivered but excluded from the actor's billed record count, as before.
    expect(runRow).toMatchObject({ status: "succeeded", fetched: 1, newCount: 1, usageUnits: 4 });
    expect(Number(runRow.cost)).toBeCloseTo(0.001 + 4 * 0.0004, 6);
    const { summary, items } = await audit(runRow);
    expect(summary).toMatchObject({ ledger: "client", delivered: 5, billedUnits: 4, distinctIds: 2, windowCutoffAt: CUTOFF });
    expect(items.map((item) => item.disposition)).toEqual(["stored", "provider_error", "no_identity", "duplicate_in_run", "outside_window"]);
    expect(items.map((item) => item.payloadJson)).toEqual([null, ...payloads.slice(1)]);
    expect(items[2]?.externalId).toBeNull();
    expect((await listRawPostingsForChannel(getDb(), "linkedin-apify")).map((raw) => raw.payloadJson)).toEqual([valid]);
  });
});

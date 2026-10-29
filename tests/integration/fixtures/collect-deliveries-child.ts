import { createDeliveryLedger } from "@/lib/channels/delivery";
import type { FetchLike } from "@/lib/channels/http";
import { createMonidChannel } from "@/lib/channels/linkedin/monid/channel";
import { monidSettingsSchema } from "@/lib/channels/linkedin/monid/contract";
import { ChannelRegistry } from "@/lib/channels/registry";
import { runCycle } from "@/lib/cycle/run-cycle";
import { CYCLE_STEP_NAMES, registerCycleStep } from "@/lib/cycle/steps";
import { getDb } from "@/lib/db";
import { upsertChannelRows } from "@/lib/db/repos/channels";
import { createCycle } from "@/lib/db/repos/cycles";
import { finishRunWithDeliveries, insertDeliveryCheckpoint } from "@/lib/db/repos/deliveries";
import { createRun } from "@/lib/db/repos/runs";

import { quietLogger } from "../../cycle/helpers";
import { CHANNEL, cycleConfig, NOW, paidChannel, paidSettings, posting, receive, UNIT_USD } from "./collect-deliveries-helpers";

/** Keep the process alive at a precise boundary until the parent kills it. */
async function waitForKill(marker: string): Promise<never> {
  process.stdout.write(`${marker}\n`);
  setInterval(() => {}, 1000);
  return new Promise<never>(() => {});
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "paid-checkpoint") {
    for (const name of CYCLE_STEP_NAMES) if (name !== "collect") registerCycleStep(name, async () => {});
    const settings = monidSettingsSchema.parse({
      enabled: true, monthly_budget_usd: 100, throttle: { min_delay_ms: 0, max_delay_ms: 0 }, max_results: 10,
      api_base_url: "https://api.monid.ai", provider: "apify", endpoint: "/harvestapi/linkedin-job-search",
      price_per_1k_usd: 1, flat_fee_usd: 0.001, poll_interval_ms: 1, timeout_ms: 20_000, stop_grace_ms: 1000,
      date_posted: { day: "24h", week: "week", month: "month", any: "" },
      input_template: { jobTitles: ["{keywords}"], locations: ["{location}"], maxItems: "{limit}" },
      remote_input: {}, remote_locations: {},
    });
    let requests = 0;
    const fetch: FetchLike = async () => {
      requests += 1;
      if (requests === 3) return waitForKill("paid-batch-captured");
      const body = requests === 1 ? { runId: "fake-paid-run", status: "READY" } : {
        runId: "fake-paid-run", status: "RUNNING", billedUnits: 5,
        output: [{ id: "paid-checkpoint", body: "verbatim output from fake Monid HTTP" }],
      };
      return {
        status: requests === 1 ? 202 : 200, ok: true, headers: { get: () => null },
        text: async () => JSON.stringify(body), json: async () => body,
      };
    };
    const registry = new ChannelRegistry();
    registry.register(createMonidChannel({
      pricePer1kUsd: () => settings.price_per_1k_usd,
      environment: { MONID_API_KEY: "fake-paid-client-test-key" }, now: () => NOW, sleep: async () => {},
    }), { settings: { ...paidSettings(), extra: settings } });
    await runCycle("manual", {
      registry, config: cycleConfig(), cascades: [], logger: quietLogger, fetch, sleep: async () => {}, now: () => NOW,
    });
    throw new Error("collect unexpectedly returned from the waiting paid client");
  }

  if (mode === "checkpoint") {
    for (const name of CYCLE_STEP_NAMES) if (name !== "collect") registerCycleStep(name, async () => {});
    const registry = new ChannelRegistry();
    registry.register(paidChannel(async (_query, ctx) => {
      await ctx.budget.consume(1);
      receive(ctx, [posting("checkpoint", { id: "checkpoint", body: "keep this entire received payload" })]);
      return waitForKill("batch-received");
    }), { settings: paidSettings() });
    await runCycle("manual", { registry, config: cycleConfig(), cascades: [], logger: quietLogger, sleep: async () => {}, now: () => NOW });
    throw new Error("collect unexpectedly returned from the waiting channel");
  }

  if (mode !== "before-commit" && mode !== "after-commit") throw new Error("unknown crash boundary");
  const db = getDb();
  await upsertChannelRows(db, [{ id: CHANNEL, family: "ats", kind: "paid", enabled: true }]);
  const cycle = await createCycle(db, { kind: "manual" });
  const run = await createRun(db, { channelId: CHANNEL, cycleId: cycle.id });
  const ledger = createDeliveryLedger({});
  const ordinals = ledger.received({ batch: ledger.beginBatch(), items: [{ id: "committed", body: "stored raw payload" }, { error: "provider refused" }] });
  ledger.drop(ordinals[1]!, "provider_error");
  // A separately committed checkpoint must survive rollback of the final transaction.
  await insertDeliveryCheckpoint(db, { runId: run.id, channelId: CHANNEL, rows: ledger.entries() });
  await finishRunWithDeliveries(db, {
    runId: run.id, channelId: CHANNEL, ledger: "client",
    raw: { items: [posting("committed", { id: "committed", body: "stored raw payload" })] },
    items: ledger.finalize({ stored: new Map([[ordinals[0]!, "committed"]]), invalid: new Set(), storeFailed: false }),
    windowCutoffAt: null, expected: { delivered: 2 },
    run: { status: "succeeded", fetched: 1, newCount: 1, usageUnits: 5, cost: 5 * UNIT_USD },
    ...(mode === "before-commit" ? { beforeCommit: () => waitForKill("inside-final-transaction") } : {}),
  });
  await waitForKill("final-commit-complete");
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});

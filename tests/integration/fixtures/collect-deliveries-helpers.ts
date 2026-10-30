import fs from "node:fs";
import path from "node:path";

import { stringify } from "yaml";

import type { Channel, ChannelContext, RawPostingInput } from "@/lib/channels/types";
import { resetConfigCache } from "@/lib/config";

import { channelsWith } from "../../channels/helpers";
import { makeTempConfig, type TempConfig } from "../../config/helpers";
import { config, probeChannel, settings } from "../../cycle/helpers";

export const NOW = new Date("2026-10-07T08:00:00Z");
export const CUTOFF = new Date("2026-10-07T02:00:00Z");
export const CHANNEL = "paid-receipts";
export const UNIT_USD = 0.002;

/** Every audit setting belongs to this test, independently of the repository defaults. */
export function auditConfig(excludeChannels: string[] = []): TempConfig {
  const temp = makeTempConfig();
  writeAuditConfig(temp, excludeChannels);
  return temp;
}

export function writeAuditConfig(temp: TempConfig, excludeChannels: string[] = []): void {
  fs.writeFileSync(path.join(temp.defaultsDir, "delivery-audit.yaml"), stringify({
    config_version: 1,
    scope: { channel_kinds: ["paid"], exclude_channels: excludeChannels },
    checkpoint: { write_timeout_ms: 1000 },
    retention: { days: 1, warn_bytes: 1_048_576 },
    prune: { every_minutes: 1, batch_size: 10, statement_timeout_ms: 1000 },
  }));
  resetConfigCache();
}

export function cycleConfig() {
  return {
    ...config(),
    channels: channelsWith((raw) => {
      raw.paid_total_monthly_budget_usd = 100;
      Object.assign(raw.http as Record<string, unknown>, { max_retries: 0 });
      Object.assign(raw.collect as Record<string, unknown>, { concurrency: 1 });
    }),
    search: {
      keyword_groups: { engineering: ["Engineer"] },
      locations: ["Example City"],
      remote_scope: "none" as const,
      window_hours: { morning: 6, evening: 6, weekend: 6 },
      max_per_group_per_location: 10, watched_company_queries: { enabled: true, max_per_cycle: 3, min_interval_hours: 24, max_results: 25 },
    },
  };
}

export const paidSettings = () => settings({
  enabled: true, maxResults: 10, monthlyBudgetUsd: 100, freeRecordsPerMonth: 0,
  throttle: { minDelayMs: 0, maxDelayMs: 0 },
});

export const posting = (id: string, payload: unknown = { id }): RawPostingInput => ({
  externalId: id, url: `https://jobs.example.test/${id}`, payload,
});

export function paidChannel(collect: Channel["collect"], id = CHANNEL): Channel {
  return {
    ...probeChannel(id, { usesQueries: false }),
    kind: "paid",
    estimateCost: (units) => units * UNIT_USD,
    collect,
  };
}

/** Tolerate the no-op recorder too, so missing collect wiring fails at the database assertions. */
export function receive(ctx: ChannelContext, postings: RawPostingInput[], batch = ctx.deliveries.beginBatch()): RawPostingInput[] {
  const ordinals = ctx.deliveries.received({ batch, items: postings.map((item) => item.payload) });
  return postings.map((item, index) => ({
    ...item,
    ...(ordinals[index] === undefined ? {} : { deliveryOrdinal: ordinals[index] }),
  }));
}

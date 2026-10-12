import { createChannelContext } from "@/lib/channels/context";
import { BudgetExceededError, ChannelError } from "@/lib/channels/errors";
import { FIXTURE_SETTINGS } from "@/lib/channels/fixture";
import type { ChannelContext } from "@/lib/channels/types";
import { configRegistry, type ChannelsConfig, type ScheduleConfig, type SearchConfig } from "@/lib/config";

import { shippedYaml } from "../config/helpers";

export function shippedChannels(): ChannelsConfig {
  return configRegistry.channels.schema.parse(shippedYaml("sources.yaml"));
}

export function shippedSearch(): SearchConfig {
  return configRegistry.search.schema.parse(shippedYaml("search.yaml"));
}

export function shippedSchedule(): ScheduleConfig {
  return configRegistry.schedule.schema.parse(shippedYaml("schedule.yaml"));
}

/** sources.yaml with a deep edit applied (the result is re-validated). */
export function channelsWith(edit: (raw: Record<string, unknown>) => void): ChannelsConfig {
  const raw = structuredClone(shippedYaml("sources.yaml"));
  edit(raw);
  return configRegistry.channels.schema.parse(raw);
}

/** A ChannelContext with free budget and no network, for calling `collect` directly. */
export function stubContext(): ChannelContext {
  return createChannelContext({
    channelId: "stub",
    settings: FIXTURE_SETTINGS,
    http: { timeoutMs: 1000, maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1 },
    budget: {
      snapshot: () => ({ month: "2026-10", records: 0, usd: 0, freeRecordsLeft: 0, usdLeft: 0 }),
      canAfford: () => true,
      consume: async () => ({ usd: 0, freeRecords: 0, paidRecords: 0 }),
    },
    signal: new AbortController().signal,
    cycle: { id: null, kind: "manual" },
  });
}

/** The ways a later page / keyword of a query can fail: a flaky server (retryable), a block (non-retryable), a budget stop. */
export const INTERRUPTIONS = ["network", "blocked", "budget_exceeded"] as const;
export type Interruption = (typeof INTERRUPTIONS)[number];

/** A classified failure of `kind`, as `ctx.http` (or the budget) raises it. */
export function interruption(kind: Interruption): ChannelError {
  if (kind === "budget_exceeded") return new BudgetExceededError("channel", "test: monthly budget exhausted");
  if (kind === "blocked") return new ChannelError("blocked", "HTTP 403 from example.test: request blocked", { status: 403, tripsCircuit: true });
  return new ChannelError("network", "HTTP 503 from example.test: server error", { status: 503 });
}

/**
 * `ctx` whose `http` throws `interruption(kind)` for the requests `fails` picks; the others go through. `n` counts the
 * requests of `ctx.http` (`request` and `json` together) from 0.
 */
export function failingHttp(ctx: ChannelContext, fails: (url: URL, n: number) => boolean, kind: Interruption): ChannelContext {
  let n = 0;
  const check = (url: string): void => {
    const index = n;
    n += 1;
    if (fails(new URL(url), index)) throw interruption(kind);
  };
  return {
    ...ctx,
    http: {
      request: async (url, init) => {
        check(url);
        return ctx.http.request(url, init);
      },
      json: async (url, schema, init) => {
        check(url);
        return ctx.http.json(url, schema, init);
      },
    },
  };
}

import { createChannelContext } from "@/lib/channels/context";
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

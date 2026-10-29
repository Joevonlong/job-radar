/** Read-only rotation estimates; collection owns scheduling and all persisted state. */
import { CHANNEL_CONFIG_TABLE, channelUsesQueries, settingsFromConfig, type ConfiguredChannelId } from "@/lib/channels/registry";
import { catchUpWindow, familyHistory, rotationSummary, turnsOf } from "@/lib/channels/rotation";
import type { SearchQuery } from "@/lib/channels/types";
import type { ChannelsConfig } from "@/lib/config";
import type { QueryRunHistoryRow } from "@/lib/db/repos/runs";
import type { MonthUsage } from "@/lib/db/repos/channels";
import { hasBudgetHeadroom } from "@/lib/channels/budget";

import type { SourceCard } from "./view";

export interface RotationUnit {
  name: string;
  channelIds: readonly string[];
}

export interface RotationStatus {
  sortChannel: string | null;
  queries: number;
  neverRun: number;
  oldestWaitHours: number | null;
  oldestWaiting: { id: string; keywordGroup: string; location: string | null; remoteScope: string | null } | null;
  overCap: number;
  maxCatchUpHours: number;
}

export function rotationUnits(config: ChannelsConfig): RotationUnit[] {
  const cascade = config.linkedin.cascade;
  const members = new Set<string>(cascade);
  return [
    ...(cascade.length ? [{ name: "cascade", channelIds: cascade }] : []),
    ...(Object.keys(CHANNEL_CONFIG_TABLE) as ConfiguredChannelId[])
      .filter((id) => !members.has(id) && channelUsesQueries(id) && settingsFromConfig(id, config).enabled)
      .map((id) => ({ name: id, channelIds: [id] })),
  ];
}

/** Matches the cascade channels' estimateCost(1); start/run fees are not part of that estimate. */
function cascadeUnitCostUsd(id: string, config: ChannelsConfig): number {
  if (id === "linkedin-brightdata") return config.linkedin.brightdata.cost_per_1k_usd / 1000;
  if (id === "linkedin-apify") return config.linkedin.apify.price_per_1k_usd / 1000;
  if (id === "linkedin-monid") return config.linkedin.monid.price_per_1k_usd / 1000;
  return 0;
}

/** Cards already use effectiveState(snapshot, now): a cooled-down open circuit is available as half_open. */
export function cascadeStartChannel(
  cards: readonly SourceCard[], config: ChannelsConfig, usage: ReadonlyMap<string, MonthUsage>, paidUsedUsd: number,
): string | null {
  return cards.find((card) => (
    card.registered && card.enabled && !card.notConfigured && card.missingEnv.length === 0
    // Session isConfigured checks cookie presence, not expiry; the circuit decides whether an expired login can probe.
    && card.login?.status !== "missing"
    && card.circuit?.state !== "open" && hasBudgetHeadroom({
      settings: { freeRecordsPerMonth: card.usage.freeRecords, monthlyBudgetUsd: card.usage.budgetUsd },
      usage: usage.get(card.id) ?? { records: 0, usd: 0 },
      unitCostUsd: cascadeUnitCostUsd(card.id, config),
      globalUsedUsd: paidUsedUsd,
      globalCapUsd: config.paid_total_monthly_budget_usd,
    })
  ))?.id ?? null;
}

export function rotationStatus(input: {
  unit: RotationUnit;
  queries: readonly SearchQuery[];
  history: readonly QueryRunHistoryRow[];
  sortChannel: string | null;
  collect: ChannelsConfig["collect"];
  now: Date;
}): RotationStatus {
  const { unit, queries, history, sortChannel, collect, now } = input;
  const summary = rotationSummary({
    queries,
    sortChannel,
    turns: sortChannel === null ? new Map() : turnsOf(history, sortChannel),
    reached: 0,
    stretched: 0,
    capped: 0,
    maxWindowHours: null,
    historyUnavailable: false,
    now,
  });
  const family = familyHistory(history, unit.channelIds);
  const overCap = queries.filter((query) => {
    const past = family.get(query.id);
    return catchUpWindow({
      baseHours: query.windowHours,
      anchor: past?.lastCoveredAt ?? past?.firstSeenAt ?? null,
      now,
      maxCatchUpHours: collect.max_catch_up_hours,
      toleranceHours: collect.catch_up_tolerance_hours,
      autoCatchUp: true,
    }).capped;
  }).length;
  return {
    sortChannel,
    queries: summary.queries,
    neverRun: summary.neverRun,
    oldestWaitHours: summary.oldestWaitHours,
    oldestWaiting: summary.oldestWaiting,
    overCap,
    maxCatchUpHours: collect.max_catch_up_hours,
  };
}

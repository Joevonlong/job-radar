/** Read-only rotation estimates; collection owns scheduling and all persisted state. */
import { CHANNEL_CONFIG_TABLE, channelUsesQueries, settingsFromConfig, type ConfiguredChannelId } from "@/lib/channels/registry";
import { catchUpWindow, familyHistory, rotationSummary, turnsOf } from "@/lib/channels/rotation";
import type { SearchQuery } from "@/lib/channels/types";
import type { ChannelsConfig } from "@/lib/config";
import type { QueryRunHistoryRow } from "@/lib/db/repos/runs";

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

function hasHeadroom(card: SourceCard, paidUsedUsd: number, paidCapUsd: number): boolean {
  // Approximates BudgetTracker.hasHeadroom for display only: channel prices are unknown to the web process.
  const { records, freeRecords, usd, budgetUsd } = card.usage;
  if (records < freeRecords) return true;
  if (budgetUsd > 0) return usd < budgetUsd && paidUsedUsd < paidCapUsd;
  return freeRecords === 0 && card.kind !== "paid";
}

/** Cards already use effectiveState(snapshot, now): a cooled-down open circuit is available as half_open. */
export function cascadeStartChannel(cards: readonly SourceCard[], paidUsedUsd: number, paidCapUsd: number): string | null {
  return cards.find((card) => (
    card.registered && card.enabled && !card.notConfigured && card.missingEnv.length === 0
    // Session isConfigured checks cookie presence, not expiry; the circuit decides whether an expired login can probe.
    && card.login?.status !== "missing"
    && card.circuit?.state !== "open" && hasHeadroom(card, paidUsedUsd, paidCapUsd)
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

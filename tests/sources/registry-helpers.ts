import type { ChannelsConfig } from "@/lib/config";
import type { ChannelStateRow } from "@/lib/db/queries/sources";
import type { BoardHealthRow, ChannelWindowStat } from "@/lib/db/queries/source-health";
import { buildSourcesView, type SourceCard, type SourcesViewInput } from "@/lib/sources/view";

import { shippedChannels } from "../channels/helpers";

export const NOW = new Date("2026-10-08T12:00:00Z");
export const HOUR = 3_600_000;

export function state(id: string, extra: Partial<ChannelStateRow> = {}): ChannelStateRow {
  return { id, family: id, kind: "api", health: "healthy", circuitState: "closed", circuitOpenUntil: null, consecutiveFailures: 0, lastErrorCode: null, lastSuccessAt: null, ...extra };
}

export function viewInput(extra: Partial<SourcesViewInput> = {}): SourcesViewInput {
  return {
    now: NOW,
    month: "2026-10",
    channelsConfig: shippedChannels(),
    aiConfig: { monthly_api_budget_usd: 10 },
    states: [],
    runsByChannel: new Map(),
    usage: new Map(),
    runTotals: new Map(),
    latestCycle: null,
    aiRows: [],
    apiSpendUsd: 0,
    lastHeartbeatAt: null,
    heartbeatIntervalSeconds: 30,
    heartbeatStaleFactor: 3,
    aiWorker: { execution: "host", online: false, lastHeartbeatAt: null, ageSeconds: null, offlineAfterSeconds: 180, queue: { pending: 0, running: 0, oldestPendingAt: null }, lastRun: null },
    ...extra,
  };
}

export function cardsFor(extra: Partial<SourcesViewInput> = {}): SourceCard[] {
  return buildSourcesView(viewInput(extra)).cards;
}

export function boardHealth(ats: string, token: string, extra: Partial<BoardHealthRow> = {}): BoardHealthRow {
  return { ats, token, lastStatus: "ok", lastErrorCode: null, lastCheckedAt: new Date(NOW.getTime() - HOUR), lastOkAt: new Date(NOW.getTime() - HOUR), consecutiveFailures: 0, lastTotal: 10, lastKept: 3, ...extra };
}

export function windowStat(extra: Partial<ChannelWindowStat> = {}): ChannelWindowStat {
  return { runs: 0, failed: 0, fetched: 0, newCount: 0, lastRun: null, ...extra };
}

export function withBoards(config: ChannelsConfig, boards: ChannelsConfig["ats_boards"]): ChannelsConfig {
  return { ...config, ats_boards: boards };
}

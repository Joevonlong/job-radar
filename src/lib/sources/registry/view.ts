/** View model of `/sources/registry` and `pnpm sources:list`: entries + health -> rows with a status and reasons. Pure. */
import { z } from "zod";

import { consentKind, type ConsentKind } from "@/lib/channels/access";
import type { ChannelsConfig, RegistrySettings } from "@/lib/config";
import { ATS_KINDS } from "@/lib/config/schemas/companies";
import type { BoardHealthRow, ChannelWindowStat } from "@/lib/db/queries/source-health";
import type { SourceRegistryRow } from "@/lib/db/repos/source-registry";

import type { SourceCard } from "../view";
import { boardEntryId, buildRegistryEntries, CHANNEL_GROUP, type RegistryEntry, type RegistryGroup, type AtsKind } from "./entries";
import { boardRegistryStatus, cascadeStandbyVerdict, channelRegistryStatus, REGISTRY_STATUSES, type RegistryReason, type RegistryStatus } from "./status";

const RECOMMENDED_ID = "linkedin-session:recommended";
const SESSION_ID = "linkedin-session";

export interface ChannelRow {
  id: string;
  type: "channel";
  group: RegistryGroup;
  name: string;
  enabled: boolean;
  status: RegistryStatus;
  reasons: RegistryReason[];
  /** The channel serves only other markets: off, its switch locked, listed under "other markets". */
  otherMarket: boolean;
  /** `markets` of sources.yaml (empty = every market). */
  markets: string[];
  /** Set while the switch cannot work because another channel is off (the "recommended for you" read needs the LinkedIn session): that channel's id. */
  needsParent: string | null;
  /** Switching it on needs the terms-of-service acknowledgement of this kind (`channels/access.ts`); null = none. */
  consent: ConsentKind | null;
  /** The newest run: when it ENDED (its start while it is still running; the same basis as `lastSuccessAt`), what it ended as, its error code. Null = never ran. */
  /** `interrupted`: the run stored what it read before its query failed part way (status `partial`). */
  lastRun: { at: string; status: string; errorCode: string | null; interrupted: boolean } | null;
  lastSuccessAt: string | null;
  /** The last `registry.window_days` days. */
  window: { runs: number; failed: number; fetched: number; newCount: number };
  /** An ATS channel: how its boards are doing. */
  boards: { total: number; failing: number; degraded: number; neverRun: number } | null;
  detail: {
    circuit: { state: "closed" | "open" | "half_open"; openUntil: string | null; consecutiveFailures: number; lastErrorCode: string | null } | null;
    usage: { usd: number; budgetUsd: number; records: number; freeRecords: number };
    /** The buttons "run now" and "test" are offered. */
    registered: boolean;
    testable: boolean;
    kind: string | null;
  };
}

export interface BoardRow {
  id: string;
  type: "ats_board";
  group: "ats";
  name: string;
  ats: AtsKind;
  token: string;
  region: "global" | "eu" | null;
  enabled: boolean;
  status: RegistryStatus;
  reasons: RegistryReason[];
  /** Result of the last check; null = never checked. */
  lastCheck: { at: string; status: "ok" | "not_modified" | "error"; errorCode: string | null; failures: number } | null;
  lastOkAt: string | null;
  /** Postings returned / kept by the last full answer. */
  lastTotal: number | null;
  lastKept: number | null;
  /** Postings seen in the window. */
  seen: number;
  /** The career page of the board (template of `registry.board_page_urls`). */
  pageUrl: string;
}

export interface RegistryView {
  counts: Record<RegistryStatus, number>;
  total: number;
  channels: ChannelRow[];
  boards: BoardRow[];
  windowDays: number;
  /** True when the rows come from the database mirror because the file is unreadable. */
  fromMirror: boolean;
}

export interface RegistryViewInput {
  now: Date;
  config: ChannelsConfig;
  /** The cards of `buildSourcesView` (so the statuses agree with `/sources`). */
  cards: readonly SourceCard[];
  channelStats: ReadonlyMap<string, ChannelWindowStat>;
  boardHealth: readonly BoardHealthRow[];
  /** `${ats}:${token}` -> postings seen in the window. */
  boardSeen: ReadonlyMap<string, number>;
}

const emptyCounts = (): Record<RegistryStatus, number> => Object.fromEntries(REGISTRY_STATUSES.map((s) => [s, 0])) as Record<RegistryStatus, number>;

const isoOrNull = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null);

export function boardPageUrl(settings: RegistrySettings, board: { ats: AtsKind; token: string; region?: string | null }): string {
  const key = board.ats === "lever" && board.region === "eu" ? "lever_eu" : board.ats;
  return settings.board_page_urls[key].replace("{token}", encodeURIComponent(board.token));
}

function boardStatus(result: ReturnType<typeof boardRegistryStatus>): Pick<BoardRow, "status" | "reasons"> {
  return { status: result.status, reasons: result.reasons };
}

function toBoardRow(entry: RegistryEntry, config: ChannelsConfig, input: RegistryViewInput, healthByKey: ReadonlyMap<string, BoardHealthRow>, channelEnabled: ReadonlyMap<string, boolean>): BoardRow {
  const ats = entry.params.ats as AtsKind;
  const token = String(entry.params.token);
  const region = entry.params.region === "eu" ? "eu" : entry.params.region === "global" ? "global" : null;
  const health = healthByKey.get(`${ats}:${token}`) ?? null;
  const verdict = boardRegistryStatus({ enabled: entry.enabled, channelEnabled: channelEnabled.get(ats) ?? false, channelId: ats, health, now: input.now, settings: config.registry });
  return {
    id: entry.id,
    type: "ats_board",
    group: "ats",
    name: entry.name,
    ats,
    token,
    region,
    enabled: entry.enabled,
    ...boardStatus(verdict),
    lastCheck: health
      ? { at: health.lastCheckedAt.toISOString(), status: health.lastStatus === "error" ? "error" : health.lastStatus === "not_modified" ? "not_modified" : "ok", errorCode: health.lastErrorCode, failures: health.consecutiveFailures }
      : null,
    lastOkAt: isoOrNull(health?.lastOkAt),
    lastTotal: health ? health.lastTotal : null,
    lastKept: health ? health.lastKept : null,
    seen: input.boardSeen.get(`${ats}:${token}`) ?? 0,
    pageUrl: boardPageUrl(config.registry, { ats, token, region }),
  };
}

/** Everything the page and the CLI show, from the validated config and the health reads. */
export function buildRegistryView(input: RegistryViewInput): RegistryView {
  const entries = buildRegistryEntries(input.config);
  const cardById = new Map(input.cards.map((card) => [card.id, card]));
  const healthByKey = new Map(input.boardHealth.map((row) => [`${row.ats}:${row.token}`, row]));
  const channelEnabled = new Map(entries.filter((e) => e.type === "channel").map((e) => [e.id, e.enabled]));

  const boards = entries.filter((e) => e.type === "ats_board").map((entry) => toBoardRow(entry, input.config, input, healthByKey, channelEnabled));
  const boardSummary = new Map<string, NonNullable<ChannelRow["boards"]>>();
  for (const ats of ATS_KINDS) {
    const own = boards.filter((b) => b.ats === ats);
    boardSummary.set(ats, {
      total: own.length,
      failing: own.filter((b) => b.status === "failing").length,
      degraded: own.filter((b) => b.status === "degraded").length,
      neverRun: own.filter((b) => b.status === "never_run").length,
    });
  }

  const channels = entries
    .filter((e) => e.type === "channel")
    .map((entry): ChannelRow => {
      const card = cardById.get(entry.id);
      const stat = input.channelStats.get(entry.id) ?? null;
      // A channel the user switched off reads "off" even when the runner has not registered it (the overview card says "not registered" first).
      const offVerdict = { status: "off" as const, reasons: [{ key: "offChannel" as const }] };
      const parentOff = entry.id === RECOMMENDED_ID && !(channelEnabled.get(SESSION_ID) ?? false) ? SESSION_ID : null;
      const otherMarket = card?.otherMarket ?? false;
      const markets = card?.markets ?? [];
      const verdict = otherMarket
        ? { status: "off" as const, reasons: [{ key: "otherMarket" as const, values: { markets: markets.join(", ") } }] }
        : parentOff !== null
          ? { status: "off" as const, reasons: [{ key: "parentOff" as const, values: { channel: parentOff } }] }
          : card && !entry.enabled && card.status === "not_registered"
            ? offVerdict
            : card
              ? (cascadeStandbyVerdict(card, input.cards, input.config.linkedin.cascade) ?? channelRegistryStatus(card))
              : { status: entry.enabled ? ("never_run" as const) : ("off" as const), reasons: [{ key: entry.enabled ? ("noRuns" as const) : ("offChannel" as const) }] };
      return {
        id: entry.id,
        type: "channel",
        group: entry.group,
        name: entry.name,
        enabled: entry.enabled,
        status: verdict.status,
        reasons: verdict.reasons,
        otherMarket,
        markets,
        needsParent: parentOff,
        consent: consentKind(entry.id),
        lastRun: stat?.lastRun ? { at: (stat.lastRun.finishedAt ?? stat.lastRun.startedAt).toISOString(), status: stat.lastRun.status, errorCode: stat.lastRun.errorCode, interrupted: stat.lastRun.interrupted } : null,
        lastSuccessAt: isoOrNull(card?.lastSuccessAt),
        window: { runs: stat?.runs ?? 0, failed: stat?.failed ?? 0, fetched: stat?.fetched ?? 0, newCount: stat?.newCount ?? 0 },
        boards: CHANNEL_GROUP[entry.id as keyof typeof CHANNEL_GROUP] === "ats" ? (boardSummary.get(entry.id) ?? null) : null,
        detail: {
          circuit: card?.circuit ? { state: card.circuit.state, openUntil: isoOrNull(card.circuit.openUntil), consecutiveFailures: card.circuit.consecutiveFailures, lastErrorCode: card.circuit.lastErrorCode } : null,
          usage: { usd: card?.usage.usd ?? 0, budgetUsd: card?.usage.budgetUsd ?? 0, records: card?.usage.records ?? 0, freeRecords: card?.usage.freeRecords ?? 0 },
          registered: card?.registered ?? false,
          testable: card?.testable ?? false,
          kind: card?.kind ?? null,
        },
      };
    });

  return finish({ channels, boards, windowDays: input.config.registry.window_days, fromMirror: false });
}

function finish(parts: Omit<RegistryView, "counts" | "total">): RegistryView {
  const counts = emptyCounts();
  for (const row of [...parts.channels, ...parts.boards]) counts[row.status] += 1;
  return { ...parts, counts, total: parts.channels.length + parts.boards.length };
}

const mirrorBoardParamsSchema = z.object({ ats: z.enum(ATS_KINDS), token: z.string(), region: z.enum(["global", "eu"]).optional() });

function mirrorBoardParams(params: unknown): { ats: AtsKind; token: string; region: "global" | "eu" | null } | null {
  const parsed = mirrorBoardParamsSchema.safeParse(params);
  return parsed.success ? { ats: parsed.data.ats, token: parsed.data.token, region: parsed.data.region ?? null } : null;
}

export interface MirrorViewInput {
  now: Date;
  rows: readonly SourceRegistryRow[];
  channelStats: ReadonlyMap<string, ChannelWindowStat>;
  boardHealth: readonly BoardHealthRow[];
  boardSeen: ReadonlyMap<string, number>;
  settings: RegistrySettings;
}

/** A coarser view from the database mirror, for when sources.yaml cannot be read (the state of the last good sync). */
export function buildRegistryViewFromMirror(input: MirrorViewInput): RegistryView {
  const { settings } = input;
  const healthByKey = new Map(input.boardHealth.map((row) => [`${row.ats}:${row.token}`, row]));
  const channelEnabled = new Map(input.rows.filter((r) => r.type === "channel").map((r) => [r.id, r.enabled]));
  const channels = input.rows
    .filter((r) => r.type === "channel")
    .map((row): ChannelRow => {
      const stat = input.channelStats.get(row.id) ?? null;
      const last = stat?.lastRun ?? null;
      // Only the last run is known here, so the grade is coarse: a failed run is failing, a partial one (cut short or with
      // some invalid records) degraded, anything else ok.
      const status: RegistryStatus = !row.enabled ? "off" : last === null ? "never_run" : last.status === "failed" ? "failing" : last.status === "partial" ? "degraded" : "ok";
      const reasons: RegistryReason[] = !row.enabled
        ? [{ key: "offChannel" }]
        : last === null
          ? [{ key: "noRuns" }]
          : last.status === "failed"
            ? [{ key: "lastRunFailed", values: { error: last.errorCode ?? "unknown" } }]
            : last.status === "partial"
              ? [{ key: "requestFailures" }]
              : [];
      return {
        id: row.id,
        type: "channel",
        group: row.sourceGroup as RegistryGroup,
        name: row.name,
        enabled: row.enabled,
        status,
        reasons,
        otherMarket: false,
        markets: [],
        needsParent: null,
        consent: consentKind(row.id),
        lastRun: last ? { at: (last.finishedAt ?? last.startedAt).toISOString(), status: last.status, errorCode: last.errorCode, interrupted: last.interrupted } : null,
        lastSuccessAt: null,
        window: { runs: stat?.runs ?? 0, failed: stat?.failed ?? 0, fetched: stat?.fetched ?? 0, newCount: stat?.newCount ?? 0 },
        boards: null,
        detail: { circuit: null, usage: { usd: 0, budgetUsd: 0, records: 0, freeRecords: 0 }, registered: false, testable: false, kind: null },
      };
    });
  const boards = input.rows
    .filter((r) => r.type === "ats_board")
    .flatMap((row): BoardRow[] => {
      const params = mirrorBoardParams(row.params);
      if (params === null) return [];
      const { ats, token, region } = params;
      const health = healthByKey.get(`${ats}:${token}`) ?? null;
      const verdict = boardRegistryStatus({ enabled: row.enabled, channelEnabled: channelEnabled.get(ats) ?? false, channelId: ats, health, now: input.now, settings });
      return [{
        id: boardEntryId(ats, token),
        type: "ats_board",
        group: "ats",
        name: row.name,
        ats,
        token,
        region,
        enabled: row.enabled,
        ...boardStatus(verdict),
        lastCheck: health ? { at: health.lastCheckedAt.toISOString(), status: health.lastStatus === "error" ? "error" : health.lastStatus === "not_modified" ? "not_modified" : "ok", errorCode: health.lastErrorCode, failures: health.consecutiveFailures } : null,
        lastOkAt: isoOrNull(health?.lastOkAt),
        lastTotal: health ? health.lastTotal : null,
        lastKept: health ? health.lastKept : null,
        seen: input.boardSeen.get(`${ats}:${token}`) ?? 0,
        pageUrl: boardPageUrl(settings, { ats, token, region }),
      }];
    });
  return finish({ channels, boards, windowDays: settings.window_days, fromMirror: true });
}

export { sortBoards } from "./board-sort";

export type { RegistryEntry };
export { type RegistryStatus };

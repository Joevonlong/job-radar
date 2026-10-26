/** The seven states of a registry entry and the one-line reasons behind them. Pure; the page and the CLI translate the reason keys. */
import type { RegistrySettings } from "@/lib/config";
import type { BoardHealthRow } from "@/lib/db/queries/source-health";

import type { ChannelTone } from "../channel-tone";
import type { SourceCard } from "../view";

export const REGISTRY_STATUSES = ["ok", "degraded", "failing", "off", "not_configured", "never_run", "standby"] as const;
export type RegistryStatus = (typeof REGISTRY_STATUSES)[number];

export type RegistryReasonKey =
  | "offChannel"
  | "otherMarket"
  | "offBoard"
  | "parentOff"
  | "noRuns"
  | "notRegistered"
  | "lastRunFailed"
  | "consecutive"
  | "circuitUntil"
  | "halfOpen"
  | "requestFailures"
  | "skipped"
  | "cascadeStandby"
  | "missingEnv"
  | "loginMissing"
  | "loginExpired"
  | "missingApify"
  | "missingMonid"
  | "notConfigured"
  | "neverChecked"
  | "boardFailing"
  | "boardFailedOnce"
  | "boardStale";

export interface RegistryReason {
  key: RegistryReasonKey;
  /** Plain values for the message (`error` = a channel error code, `count`, `names`, `hours`, `channel`). */
  values?: Record<string, string | number>;
  /** An instant (ISO string) the renderer formats in the configured time zone as `{when}`. */
  at?: string;
}

export interface RegistryVerdict {
  status: RegistryStatus;
  /** Why, most important first; empty for a healthy source. */
  reasons: RegistryReason[];
}

/** Sort order: failing first, switched-off last. */
export const STATUS_SEVERITY: Record<RegistryStatus, number> = { failing: 0, degraded: 1, never_run: 2, ok: 3, standby: 4, not_configured: 5, off: 6 };

/** Light colour of a status (the same tones as the channel cards). */
export function registryTone(status: RegistryStatus): ChannelTone {
  switch (status) {
    case "ok":
      return "good";
    case "degraded":
      return "warn";
    case "failing":
      return "bad";
    case "off":
    case "not_configured":
    case "never_run":
    case "standby":
      return "idle";
  }
}

export function isRegistryStatus(value: string): value is RegistryStatus {
  return (REGISTRY_STATUSES as readonly string[]).includes(value);
}

const iso = (date: Date): string => date.toISOString();

/** A channel's verdict from the card `/sources` shows, so both pages always agree. */
export function channelRegistryStatus(card: SourceCard): RegistryVerdict {
  const errorCode = card.circuit?.lastErrorCode ?? card.runs.find((run) => run.errorCode !== null)?.errorCode ?? null;
  const failureParts = (): RegistryReason[] => {
    const parts: RegistryReason[] = [{ key: "lastRunFailed", values: { error: errorCode ?? "unknown" } }];
    if (card.circuit && card.circuit.consecutiveFailures > 0) parts.push({ key: "consecutive", values: { count: card.circuit.consecutiveFailures } });
    if (card.circuit?.state === "open" && card.circuit.openUntil) parts.push({ key: "circuitUntil", at: iso(card.circuit.openUntil) });
    return parts;
  };
  switch (card.status) {
    case "ok":
      return { status: "ok", reasons: [] };
    case "off":
      if (card.otherMarket) return { status: "off", reasons: [{ key: "otherMarket", values: { markets: card.markets.join(", ") } }] };
      return { status: "off", reasons: [{ key: "offChannel" }] };
    case "failing":
    case "open":
      return { status: "failing", reasons: failureParts() };
    case "half_open":
      return { status: "degraded", reasons: [{ key: "halfOpen" }] };
    case "degraded":
      if (card.skipped) return { status: "degraded", reasons: [{ key: "skipped", values: { count: card.skipped.cycles, error: card.skipped.errorCode ?? "unknown" } }] };
      return { status: "degraded", reasons: [{ key: "requestFailures" }, ...(card.circuit && card.circuit.consecutiveFailures > 0 ? [{ key: "consecutive" as const, values: { count: card.circuit.consecutiveFailures } }] : [])] };
    case "missing_credentials":
      return { status: "not_configured", reasons: [missingReason(card)] };
    case "not_registered":
      return { status: "never_run", reasons: [{ key: "notRegistered" }] };
    case "idle":
      return { status: "never_run", reasons: [{ key: "noRuns" }] };
  }
}

/**
 * A channel behind an available earlier step of `linkedin.cascade` that has never been reached is on standby (the same word the cascade
 * card of `/sources` uses). Anything else (a channel with runs, off, failing, ...) keeps its own verdict.
 */
export function cascadeStandbyVerdict(card: SourceCard, cards: readonly SourceCard[], cascade: readonly string[]): RegistryVerdict | null {
  const index = cascade.indexOf(card.id);
  if (index <= 0 || !card.enabled || card.status !== "idle") return null;
  const earlierAvailable = cascade.slice(0, index).some((id) => {
    const earlier = cards.find((c) => c.id === id);
    return earlier !== undefined && earlier.enabled && (earlier.status === "ok" || earlier.status === "degraded" || earlier.status === "idle");
  });
  return earlierAvailable ? { status: "standby", reasons: [{ key: "cascadeStandby" }] } : null;
}

function missingReason(card: SourceCard): RegistryReason {
  if (card.missingEnv.length > 0) return { key: "missingEnv", values: { names: card.missingEnv.join(", ") } };
  if (card.login?.status === "missing") return { key: "loginMissing" };
  if (card.login?.status === "expired") return { key: "loginExpired" };
  if (card.id === "linkedin-apify") return { key: "missingApify" };
  if (card.id === "linkedin-monid") return { key: "missingMonid" };
  return { key: "notConfigured" };
}

export interface BoardStatusInput {
  /** The board's own `enabled`. */
  enabled: boolean;
  /** Its ATS channel is switched on. */
  channelEnabled: boolean;
  /** The ATS channel id (for the reason text). */
  channelId: string;
  /** The stored result of its last check; null = never checked. */
  health: BoardHealthRow | null;
  now: Date;
  settings: Pick<RegistrySettings, "board_failing_after" | "board_stale_hours">;
}

/** An ATS board's verdict: the first matching rule wins (switched off, never checked, failing, unstable, stale, ok). */
export function boardRegistryStatus(input: BoardStatusInput): RegistryVerdict {
  if (!input.enabled) return { status: "off", reasons: [{ key: "offBoard" }] };
  if (!input.channelEnabled) return { status: "off", reasons: [{ key: "parentOff", values: { channel: input.channelId } }] };
  const { health } = input;
  if (health === null) return { status: "never_run", reasons: [{ key: "neverChecked" }] };
  if (health.lastStatus === "error") {
    const error = health.lastErrorCode ?? "unknown";
    if (health.consecutiveFailures >= input.settings.board_failing_after) {
      return { status: "failing", reasons: [{ key: "boardFailing", values: { count: health.consecutiveFailures, error } }] };
    }
    return { status: "degraded", reasons: [{ key: "boardFailedOnce", values: { error } }] };
  }
  const ageMs = input.now.getTime() - health.lastCheckedAt.getTime();
  if (ageMs > input.settings.board_stale_hours * 3_600_000) return { status: "degraded", reasons: [{ key: "boardStale", values: { hours: Math.floor(ageMs / 3_600_000) } }] };
  return { status: "ok", reasons: [] };
}

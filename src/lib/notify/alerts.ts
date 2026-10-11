import { z } from "zod";

import { monthKey } from "@/lib/channels/budget";
import type { AiConfig, ChannelsConfig } from "@/lib/config";
import { listProviderHealth } from "@/lib/ai/health";
import { createDbQuotaStore, readQuotaStatuses, type QuotaLevel, type QuotaReason } from "@/lib/ai/quota-guard";
import type { Db } from "@/lib/db/client";
import { getChannelRows, getMonthUsage } from "@/lib/db/repos/channels";
import { sumAiCostForMonth } from "@/lib/db/repos/ai-usage";
import {
  ALERT_KIND_PREFIX,
  listAlertsSentSince,
  listUnsentQueuedAlerts,
  markNotificationSent,
  recordNotification,
  type QueuedAlert,
  type SentAlert,
} from "@/lib/db/repos/notifications";

import { formatAlert } from "./format";
import { isTelegramError } from "./telegram-client";
import { notifyText, type NotifyText } from "./text";
import { formatLocalTime, isQuietHours } from "./time";
import type { NotifyDeps } from "./types";

/**
 * Alerts: circuit breaker open, login expired / verification page, budget at 80% /
 * 100%, all AI providers failed, a cycle that did not finish. Each alert has a kind and a key (the
 * channel, the budget scope, ...); the same kind + key is sent at most once per
 * `alerts.dedupe_hours`. Alerts ignore quiet hours when `quiet_hours.alerts_exempt` is set.
 */

export interface AlertCandidate {
  kind: string;
  key: string;
  title: string;
  detail: string;
  /** Set for alerts another feature queued as an unsent `notifications` row: that row is updated instead of a new one inserted. */
  notificationId?: number;
  /** Set for the usage-cap alerts: the provider and the level the alert announces (stored as `notifiedLevel` once dealt with). */
  quota?: { provider: string; level: QuotaLevel };
}

export interface AlertChannel {
  id: string;
  family: string;
  enabled: boolean;
  circuitState: "closed" | "open" | "half_open";
  lastErrorCode: string | null;
}

export interface AlertBudget {
  /** Stable key, e.g. `global`, `channel:linkedin-brightdata`, `ai-api` (also decides the alert's wording). */
  scope: string;
  usedUsd: number;
  capUsd: number;
}

export interface AlertInput {
  channels: readonly AlertChannel[];
  /** Error code counts of this cycle's collect step, per channel. */
  collectErrors: ReadonlyArray<{ channelId: string; errorCodes: Readonly<Record<string, number>> }>;
  budgets: readonly AlertBudget[];
  /** Fractions of a budget that raise an alert (`alerts.budget_thresholds`). */
  budgetThresholds: readonly number[];
  /** Whether every AI provider failed for some task in this cycle. */
  aiAllProvidersFailed: boolean;
  /** Job Radar's AI usage cap per subscription CLI (absent / empty when the cap is off). */
  aiQuota?: AlertQuotaInput;
}

/** One guarded provider's usage-cap state, as the alerts need it. */
export interface AlertQuota {
  provider: string;
  level: QuotaLevel;
  /** `window` = Job Radar's own window cap; `error` = a limit the provider reported (the cooldown). */
  reason: QuotaReason | null;
  resumeAt: Date | null;
  windowRequests: number;
  hardRequests: number;
  windowHours: number;
  /** The level the last usage-cap alert was about (null = none yet). */
  notifiedLevel: QuotaLevel | null;
}

export interface AlertQuotaInput {
  providers: readonly AlertQuota[];
  /** `quota_guard.notify_recovery`. */
  notifyRecovery: boolean;
  now: Date;
  timeZone: string;
}

/** The usage-cap alert kinds; their anti-flap window is `quota_guard.alert_dedupe_hours`, not `alerts.dedupe_hours`. */
export const QUOTA_ALERT_KINDS = ["quota_hard", "quota_cooldown", "quota_recovered"] as const;

/** Channel ids of the LinkedIn session channels: `linkedin-session` and `linkedin-session:recommended`. */
const LINKEDIN_SESSION_PREFIX = "linkedin-session";

const money = (usd: number): string => `$${(Math.round(usd * 100) / 100).toFixed(2)}`;

const CHANNEL_SCOPE = "channel:";

function budgetTitle(scope: string, percent: number, text: NotifyText): string {
  if (scope.startsWith(CHANNEL_SCOPE)) return text.t("alert.budgetChannelTitle", { channel: scope.slice(CHANNEL_SCOPE.length), percent });
  return scope === "ai-api" ? text.t("alert.budgetAiTitle", { percent }) : text.t("alert.budgetGlobalTitle", { percent });
}

/** Pure: the alerts the current state calls for (before the dedupe window is applied), worded in `text`'s language. */
export function buildAlerts(input: AlertInput, text: NotifyText): AlertCandidate[] {
  const { t } = text;
  const alerts: AlertCandidate[] = [];
  const familyOf = new Map(input.channels.map((c) => [c.id, c.family]));

  for (const channel of input.channels) {
    if (channel.enabled && channel.circuitState === "open") {
      alerts.push({
        kind: "circuit_open",
        key: channel.id,
        title: t("alert.circuitOpenTitle", { channel: channel.id }),
        detail: channel.lastErrorCode ? t("alert.circuitOpenDetailWithError", { code: channel.lastErrorCode }) : t("alert.circuitOpenDetail"),
      });
    }
  }

  for (const entry of input.collectErrors) {
    const isLinkedinSession = entry.channelId.startsWith(LINKEDIN_SESSION_PREFIX);
    if ((entry.errorCodes.auth_expired ?? 0) > 0) {
      alerts.push({
        kind: "auth_expired",
        key: entry.channelId,
        title: isLinkedinSession ? t("alert.linkedinAuthTitle") : t("alert.authTitle", { channel: entry.channelId }),
        detail: isLinkedinSession ? t("alert.linkedinAuthDetail", { channel: entry.channelId }) : t("alert.authDetail"),
      });
    }
    if ((entry.errorCodes.blocked ?? 0) > 0 && familyOf.get(entry.channelId) === "linkedin") {
      alerts.push({
        kind: "verification",
        key: entry.channelId,
        title: t("alert.verificationTitle", { channel: entry.channelId }),
        detail: isLinkedinSession ? t("alert.linkedinVerificationDetail") : t("alert.verificationDetail"),
      });
    }
  }

  const thresholds = [...input.budgetThresholds].sort((a, b) => b - a);
  for (const budget of input.budgets) {
    if (budget.capUsd <= 0) continue;
    const ratio = budget.usedUsd / budget.capUsd;
    const crossed = thresholds.find((t) => ratio + 1e-9 >= t);
    if (crossed === undefined) continue;
    const percent = Math.round(crossed * 100);
    alerts.push({
      kind: `budget_${percent}`,
      key: budget.scope,
      title: budgetTitle(budget.scope, Math.round(ratio * 100), text),
      detail: t(crossed >= 1 ? "alert.budgetDetailCapped" : "alert.budgetDetail", { used: money(budget.usedUsd), cap: money(budget.capUsd), threshold: percent }),
    });
  }

  if (input.aiAllProvidersFailed) {
    alerts.push({ kind: "ai_failed", key: "all", title: t("alert.aiFailedTitle"), detail: t("alert.aiFailedDetail") });
  }
  if (input.aiQuota) alerts.push(...quotaAlerts(input.aiQuota, text));
  return alerts;
}

/**
 * Pure: the usage-cap alerts, on state changes only (`level` differs from `notifiedLevel`): entering a window cap or a
 * provider-reported cooldown once, and back to usable once (when `notify_recovery` is on). A state that lasts never
 * repeats its alert; the per-cycle cap never alerts (it resets every cycle).
 */
export function quotaAlerts(input: AlertQuotaInput, text: NotifyText): AlertCandidate[] {
  const { t } = text;
  const alerts: AlertCandidate[] = [];
  for (const q of input.providers) {
    if (q.level === q.notifiedLevel) continue;
    const time = q.resumeAt ? formatLocalTime(q.resumeAt, input.timeZone, input.now) : "none";
    if (q.level === "hard" && q.reason === "window") {
      alerts.push({
        kind: "quota_hard",
        key: q.provider,
        title: t("alert.quotaHardTitle", { provider: q.provider }),
        detail: t("alert.quotaHardDetail", { count: q.windowRequests, hours: q.windowHours, cap: q.hardRequests, time }),
        quota: { provider: q.provider, level: "hard" },
      });
    } else if (q.level === "hard" && q.reason === "error") {
      alerts.push({
        kind: "quota_cooldown",
        key: q.provider,
        title: t("alert.quotaCooldownTitle", { provider: q.provider }),
        detail: t("alert.quotaCooldownDetail", { time }),
        quota: { provider: q.provider, level: "hard" },
      });
    } else if (q.level === "ok" && q.notifiedLevel === "hard" && input.notifyRecovery) {
      alerts.push({
        kind: "quota_recovered",
        key: q.provider,
        title: t("alert.quotaRecoveredTitle", { provider: q.provider }),
        detail: t("alert.quotaRecoveredDetail"),
        quota: { provider: q.provider, level: "ok" },
      });
    }
  }
  return alerts;
}

/** Pure: providers back to usable while `notify_recovery` is off: nothing is sent, the state is only marked as dealt with. */
export function silentQuotaRecoveries(input: AlertQuotaInput): Array<{ provider: string; level: QuotaLevel }> {
  if (input.notifyRecovery) return [];
  return input.providers.filter((q) => q.level === "ok" && q.notifiedLevel === "hard").map((q) => ({ provider: q.provider, level: "ok" as const }));
}

/**
 * Why a cycle did not finish, as a code (the wording is the Telegram language's): `orphaned_on_restart` = still open
 * when the runner restarted (`count` cycles), `cycle_failed` = it ended in failure (`detail`: the cycle's own reason, shown as
 * it is when there is one).
 */
export type CycleIncompleteReason = { code: "orphaned_on_restart"; count: number } | { code: "cycle_failed"; detail: string | null };

/** A cycle that did not finish (runner restart, crash, cancelled). */
export function cycleIncompleteAlert(input: { cycleId: number | null; kind: string; reason: CycleIncompleteReason }, text: NotifyText): AlertCandidate {
  const { t } = text;
  const reason = input.reason;
  return {
    kind: "cycle_incomplete",
    key: input.cycleId === null ? input.kind : String(input.cycleId),
    title: input.cycleId === null ? t("alert.cycleIncompleteTitle", { kind: input.kind }) : t("alert.cycleIncompleteTitleWithId", { kind: input.kind, id: input.cycleId }),
    detail: reason.code === "orphaned_on_restart" ? t("alert.orphanedOnRestart", { count: reason.count }) : (reason.detail ?? t("alert.cycleFailed")),
  };
}

/** The host ai-worker has not sent a heartbeat for too long: scoring, translation and the push wait for it. */
export function aiWorkerOfflineAlert(input: { offlineSeconds: number }, text: NotifyText): AlertCandidate {
  const minutes = Math.max(1, Math.round(input.offlineSeconds / 60));
  return {
    kind: "ai_worker_offline",
    key: "ai-worker",
    title: text.t("alert.aiWorkerOfflineTitle"),
    detail: text.t("alert.aiWorkerOfflineDetail", { minutes }),
  };
}

const queuedPayloadSchema = z
  .object({
    key: z.string().optional(),
    title: z.string().optional(),
    detail: z.string().optional(),
    message: z.string().optional(),
    text: z.string().optional(),
  })
  .passthrough();

/** Pure: an `alert.*` row queued by another feature → a candidate (payload fields are optional; the kind is the fallback title). */
export function queuedAlertToCandidate(row: QueuedAlert, text: NotifyText): AlertCandidate {
  const payload = queuedPayloadSchema.safeParse(row.payload);
  const p = payload.success ? payload.data : {};
  return {
    kind: row.kind,
    key: p.key ?? "",
    title: p.title ?? text.t("alert.generic", { kind: row.kind }),
    detail: p.detail ?? p.message ?? p.text ?? "",
    notificationId: row.id,
  };
}

/**
 * Pure: drop alerts already sent within `windowHours` (same kind + key) and duplicates inside `candidates`. A kind listed
 * in `windowHoursByKind` uses its own window instead.
 */
export function dedupeAlerts(
  candidates: readonly AlertCandidate[],
  sent: readonly SentAlert[],
  input: { now: Date; windowHours: number; windowHoursByKind?: Readonly<Record<string, number>> },
): AlertCandidate[] {
  const windowOf = (kind: string): number => input.windowHoursByKind?.[kind] ?? input.windowHours;
  const seen = new Set(sent.filter((s) => s.sentAt.getTime() >= input.now.getTime() - windowOf(s.kind) * 3_600_000).map((s) => `${s.kind}\u0000${s.key}`));
  const result: AlertCandidate[] = [];
  for (const candidate of candidates) {
    const id = `${candidate.kind}\u0000${candidate.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(candidate);
  }
  return result;
}

// ---------------------------------------------------------------- gathering the current state

const collectErrorsSchema = z.object({
  channels: z.record(z.string(), z.object({ errorCodes: z.record(z.string(), z.number()).default({}) })).default({}),
});

const aiResultSchema = z.object({
  subtasks: z.array(z.object({ status: z.string(), error: z.string().optional() })).default([]),
});

/** `ctx.results.collect` → error code counts per channel; anything unexpected is treated as "no errors". */
export function collectErrorsOf(collectResult: unknown): AlertInput["collectErrors"] {
  const parsed = collectErrorsSchema.safeParse(collectResult);
  if (!parsed.success) return [];
  return Object.entries(parsed.data.channels).map(([channelId, c]) => ({ channelId, errorCodes: c.errorCodes }));
}

/** True when an AI sub-task of the cycle failed because no provider could take it. */
export function aiAllProvidersFailed(aiResult: unknown): boolean {
  const parsed = aiResultSchema.safeParse(aiResult);
  return parsed.success && parsed.data.subtasks.some((s) => s.status === "failed" && /^AiUnavailableError\b/.test(s.error ?? ""));
}

export interface GatherInput {
  db: Db;
  now: Date;
  timeZone: string;
  channelsConfig: ChannelsConfig;
  /** Monthly budget of a channel (`registry.settingsFor(...).monthlyBudgetUsd`); undefined for unknown channels. */
  channelBudgetUsd: (channelId: string) => number | undefined;
  aiMonthlyBudgetUsd: number;
  aiApiProviders: readonly string[];
  budgetThresholds: readonly number[];
  collectResult: unknown;
  aiResult: unknown;
  /** ai.yaml, for the usage-cap state (`quota_guard`); without it no usage-cap alert is raised. */
  aiConfig?: Pick<AiConfig, "quota_guard" | "cooldown">;
}

/** Read the circuit / budget state from the database and assemble the `buildAlerts` input. */
export async function gatherAlertInput(input: GatherInput): Promise<AlertInput> {
  const month = monthKey(input.now, input.timeZone);
  const [channelRows, usage, aiSpent] = await Promise.all([
    getChannelRows(input.db),
    getMonthUsage(input.db, month),
    sumAiCostForMonth(input.db, { month, timeZone: input.timeZone, providers: input.aiApiProviders }),
  ]);

  const budgets: AlertBudget[] = [];
  let paidTotal = 0;
  for (const [id, used] of usage) {
    paidTotal += used.usd;
    const cap = input.channelBudgetUsd(id);
    if (cap !== undefined) budgets.push({ scope: `${CHANNEL_SCOPE}${id}`, usedUsd: used.usd, capUsd: cap });
  }
  budgets.push({ scope: "global", usedUsd: paidTotal, capUsd: input.channelsConfig.paid_total_monthly_budget_usd });
  budgets.push({ scope: "ai-api", usedUsd: aiSpent, capUsd: input.aiMonthlyBudgetUsd });
  // the usage-cap state is read fail-open: a read error only leaves its alerts out
  const aiQuota = input.aiConfig ? await gatherQuota(input.db, input.aiConfig, input.now, input.timeZone).catch(() => undefined) : undefined;

  return {
    channels: channelRows.map((c) => ({ id: c.id, family: c.family, enabled: c.enabled, circuitState: c.circuitState, lastErrorCode: c.lastErrorCode })),
    collectErrors: collectErrorsOf(input.collectResult),
    budgets,
    budgetThresholds: input.budgetThresholds,
    aiAllProvidersFailed: aiAllProvidersFailed(input.aiResult),
    ...(aiQuota ? { aiQuota } : {}),
  };
}

async function gatherQuota(db: Db, config: Pick<AiConfig, "quota_guard" | "cooldown">, now: Date, timeZone: string): Promise<AlertQuotaInput> {
  const health = await listProviderHealth(db);
  const statuses = await readQuotaStatuses(createDbQuotaStore(db), config, health, now);
  return {
    providers: [...statuses.values()].map((s) => ({
      provider: s.provider,
      level: s.level,
      reason: s.reason,
      resumeAt: s.resumeAt,
      windowRequests: s.windowRequests,
      hardRequests: s.hardRequests,
      windowHours: s.windowHours,
      notifiedLevel: s.notifiedLevel,
    })),
    notifyRecovery: config.quota_guard.notify_recovery,
    now,
    timeZone,
  };
}

// ---------------------------------------------------------------- delivery

export interface AlertDelivery {
  sent: number;
  /** Dropped by the dedupe window. */
  deduped: number;
  failed: number;
  /** Held back because of quiet hours (`alerts_exempt: false`). */
  quiet: boolean;
}

export interface DeliverAlertsOptions {
  /** Anti-flap window per kind, overriding `alerts.dedupe_hours` (the usage-cap kinds). */
  dedupeHoursByKind?: Readonly<Record<string, number>>;
  /** Called for every alert that was sent or dropped by the dedupe window (not for a failed send or quiet hours). */
  onHandled?: (alert: AlertCandidate) => Promise<void>;
}

/**
 * Send the alerts that are not deduped, recording each sent one (kind + key + time) in
 * `notifications`. A failed send is not recorded, so the next cycle retries it.
 */
export async function deliverAlerts(deps: NotifyDeps, candidates: readonly AlertCandidate[], cycleId: number | null = null, options: DeliverAlertsOptions = {}): Promise<AlertDelivery> {
  const now = deps.now();
  if (candidates.length === 0) return { sent: 0, deduped: 0, failed: 0, quiet: false };
  if (!deps.config.quiet_hours.alerts_exempt && isQuietHours(now, deps.timeZone, deps.config.quiet_hours)) {
    deps.logger.info("alerts held back by quiet hours", { count: candidates.length });
    return { sent: 0, deduped: 0, failed: 0, quiet: true };
  }
  const windowHours = deps.config.alerts.dedupe_hours;
  const windowHoursByKind = options.dedupeHoursByKind ?? {};
  const longest = Math.max(windowHours, ...Object.values(windowHoursByKind));
  const sentBefore = await listAlertsSentSince(deps.db, new Date(now.getTime() - longest * 3_600_000));
  const fresh = dedupeAlerts(candidates, sentBefore, { now, windowHours, windowHoursByKind });
  const freshSet = new Set(fresh);
  const result: AlertDelivery = { sent: 0, deduped: candidates.length - fresh.length, failed: 0, quiet: false };

  // queued rows that are duplicates must not stay unsent forever
  for (const dropped of candidates.filter((c) => !freshSet.has(c) && c.notificationId !== undefined)) {
    await markNotificationSent(deps.db, dropped.notificationId as number, { messageId: null, sentAt: now, deduped: true });
  }
  for (const dropped of candidates.filter((c) => !freshSet.has(c))) await handled(deps, options, dropped);

  for (const alert of fresh) {
    try {
      const message = await deps.client.sendMessage({ chatId: deps.chatId, text: formatAlert(alert.title, alert.detail) });
      if (alert.notificationId !== undefined) {
        await markNotificationSent(deps.db, alert.notificationId, { messageId: message.messageId, sentAt: deps.now() });
      } else {
        await recordNotification(deps.db, {
          kind: `${ALERT_KIND_PREFIX}${alert.kind}`,
          cycleId,
          payload: { key: alert.key, title: alert.title },
          sentAt: deps.now(),
          telegramMessageId: message.messageId,
        });
      }
      result.sent += 1;
      await handled(deps, options, alert);
    } catch (error) {
      result.failed += 1;
      deps.logger.warn("alert could not be sent", { kind: alert.kind, key: alert.key, error: isTelegramError(error) ? error.message : "unexpected error" });
    }
  }
  return result;
}

async function handled(deps: NotifyDeps, options: DeliverAlertsOptions, alert: AlertCandidate): Promise<void> {
  if (!options.onHandled) return;
  try {
    await options.onHandled(alert);
  } catch (error) {
    deps.logger.warn("alert follow-up failed", { kind: alert.kind, key: alert.key, error: error instanceof Error ? error.message.slice(0, 200) : "unexpected error" });
  }
}

/** Alerts other features queued as unsent `alert.*` rows (e.g. a failed backup), as candidates. */
export async function loadQueuedAlerts(db: Db, text: NotifyText = notifyText()): Promise<AlertCandidate[]> {
  return (await listUnsentQueuedAlerts(db)).map((row) => queuedAlertToCandidate(row, text));
}

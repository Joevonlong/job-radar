import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { loadHiddenSettings } from "@/lib/applications/hidden";
import { createDbQuotaStore, recordQuotaNotified } from "@/lib/ai/quota-guard";
import { QUOTA_GUARD_CODE } from "@/lib/ai/errors";
import { SCORE_SUBTASK_NAME } from "@/lib/scoring/score-task";
import { AI_PROVIDER_IDS } from "@/lib/ai/types";
import { loadConfig, type AiConfig, type NotifyConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import type { Db } from "@/lib/db/client";
import { getCycle } from "@/lib/db/repos/cycles";
import { getRunAiNotificationWindow } from "@/lib/db/repos/control-requests";
import {
  listNotifiedJobIds,
  listPushCandidates,
  NOTIFICATION_KINDS,
  recordNotification,
  type PushCandidate,
} from "@/lib/db/repos/notifications";
import { hasDeliveredNotificationWindow, recordDigestDelivery, retainNotificationWindow, type DigestWindow } from "@/lib/db/repos/notification-windows";
import type { CycleStepContext, CycleStepFn, StepResult } from "@/lib/cycle/steps";
import { buildWatchedCompanyKeys } from "@/lib/companies/marks";
import { isResumeKitConfigured } from "@/lib/resume/config";
import { isHighValueSignal } from "@/lib/signals/bonus";
import { loadHighValuePolicy, loadSignalCatalog } from "@/lib/signals/floor";

import { buildAlerts, deliverAlerts, gatherAlertInput, loadQueuedAlerts, QUOTA_ALERT_KINDS, silentQuotaRecoveries, type AlertDelivery } from "./alerts";
import { formatJobMessage, formatSummary, jobKeyboard } from "./format";
import { createTelegramRuntime, type TelegramRuntime } from "./runtime";
import { hasHighSignal, reachesPushScore, selectForPush } from "./select";
import { isTelegramError } from "./telegram-client";
import { formatLocalTime, isQuietHours } from "./time";
import { notifyText, type NotifyText } from "./text";
import type { NotifyDeps } from "./types";
import { trapsEnabled } from "@/lib/traps/settings";

/**
 * The `notify` cycle step: alerts first (they ignore quiet hours), then — unless
 * it is quiet — one summary message and one message per selected job. Jobs that were not sent stay
 * candidates for `candidate_window_hours`; failed or deferred digests retain their original window until delivery.
 */

export interface NotifyStepOptions {
  loadNotifyConfig?: () => NotifyConfig;
  /** ai.yaml (budget and usage-cap alerts); default: the loaded config. */
  loadAiConfig?: () => AiConfig;
  /** Override how the Telegram client is built (tests use a fake Bot API server). */
  createRuntime?: (ctx: CycleStepContext, config: NotifyConfig) => TelegramRuntime | null;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The Telegram texts (tests pick the language); default: `notify.locale` of language.yaml. */
  notifyText?: () => NotifyText;
}

export interface NotifyJobsResult {
  /** Jobs first seen during this cycle. */
  newJobs: number;
  passedFilter: number;
  /** Eligible for a push (selected + cut by the cap). */
  qualified: number;
  pushed: number;
  overflow: number;
  failed: number;
  skipped: { alreadyNotified: number; filteredOut: number; unscored: number; belowThreshold: number };
}

export interface NotifyStepResult {
  skipped?: "disabled" | "not_configured" | "no_database";
  alerts?: AlertDelivery;
  /** A failed or deferred summary keeps its window; later notify runs inherit it independently of the queue. */
  retry?: { since: string; startedAt: string; lateAiComplete?: true };
  deliveredByCycleId?: number;
  /** Job messages were held back (quiet hours or a newer queued run), or already sent for this cycle. */
  jobs?: NotifyJobsResult | { deferred: "quiet_hours" | "already_sent" | "newer_cycle_pending" };
}

const notificationRetrySchema = z.object({ retry: z.object({ since: z.iso.datetime(), startedAt: z.iso.datetime(), lateAiComplete: z.literal(true).optional() }) });

/** The saved window mirror, including the legacy AI phase checkpoint used during shutdown recovery. */
export function notificationRetryOf(result: unknown): NotifyStepResult["retry"] | null {
  const parsed = notificationRetrySchema.safeParse(result);
  return parsed.success ? parsed.data.retry : null;
}

const failedSourcesSchema = z.object({
  channels: z
    .record(
      z.string(),
      z.object({ failed: z.number().default(0), interrupted: z.number().default(0), errorCodes: z.record(z.string(), z.number()).default({}) }),
    )
    .default({}),
  unusable: z.record(z.string(), z.string()).default({}),
});

/** Sources that failed (also after some pages: interrupted) or were given up on during collect, with their error codes. */
export function failedSourcesOf(collectResult: unknown): Array<{ channelId: string; reasons: string[] }> {
  const parsed = failedSourcesSchema.safeParse(collectResult);
  if (!parsed.success) return [];
  const result = new Map<string, Set<string>>();
  for (const [id, channel] of Object.entries(parsed.data.channels)) {
    if (channel.failed > 0 || channel.interrupted > 0) result.set(id, new Set(Object.keys(channel.errorCodes)));
  }
  for (const [id, code] of Object.entries(parsed.data.unusable)) result.set(id, (result.get(id) ?? new Set()).add(code));
  return [...result].map(([channelId, reasons]) => ({ channelId, reasons: [...reasons].sort() }));
}

const resumeAtSchema = z.string().nullable().optional().catch(undefined);

const aiQuotaResultSchema = z.object({
  skipped: z.string().optional().catch(undefined),
  resumeAt: resumeAtSchema,
  subtasks: z
    .array(
      z.object({
        name: z.string().optional().catch(undefined),
        reason: z.string().optional().catch(undefined),
        resumeAt: resumeAtSchema,
        result: z
          .object({ stopped: z.string().optional().catch(undefined), quotaResumeAt: resumeAtSchema, quotaHeldJobIds: z.array(z.number().int()).optional().catch(undefined) })
          .optional()
          .catch(undefined),
      }),
    )
    .default([])
    .catch([]),
});

/**
 * Whether Job Radar's AI usage cap held this cycle's AI back (the step skipped, a sub-task skipped, or scoring stopped
 * early), and the earliest known time it is expected to work again (null = the next cycle). Null when it did not.
 * `heldJobIds`: when the scoring ran, the jobs the cap left unscored (empty when the cap did not stop the scoring);
 * null when the scoring never ran (the cap held all of it back).
 */
export function aiQuotaHoldOf(aiResult: unknown): { resumeAt: Date | null; heldJobIds: ReadonlySet<number> | null } | null {
  const parsed = aiQuotaResultSchema.safeParse(aiResult);
  if (!parsed.success) return null;
  const times: Array<string | null | undefined> = [];
  if (parsed.data.skipped === QUOTA_GUARD_CODE) times.push(parsed.data.resumeAt);
  for (const subtask of parsed.data.subtasks) {
    if (subtask.reason === QUOTA_GUARD_CODE) times.push(subtask.resumeAt);
    if (subtask.result?.stopped === QUOTA_GUARD_CODE) times.push(subtask.result.quotaResumeAt);
  }
  if (times.length === 0) return null;
  const known = times.map((t) => (t ? new Date(t).getTime() : Number.NaN)).filter((t) => !Number.isNaN(t));
  const scoring = parsed.data.subtasks.find((s) => s.name === SCORE_SUBTASK_NAME && s.result !== undefined);
  const heldJobIds = scoring ? new Set(scoring.result?.stopped === QUOTA_GUARD_CODE ? (scoring.result.quotaHeldJobIds ?? []) : []) : null;
  return { resumeAt: known.length > 0 ? new Date(Math.min(...known)) : null, heldJobIds };
}

function describe(error: unknown): string {
  return isTelegramError(error) ? error.message : error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "unexpected error";
}

async function sendJobs(deps: NotifyDeps, ctx: CycleStepContext, db: Db, cycleId: number, digest: DigestWindow, candidates: PushCandidate[]): Promise<{ jobs: NotifyJobsResult; summarySent: boolean }> {
  const { config } = deps;
  const text = deps.text ?? notifyText();
  const pipeline = loadPipeline();
  const interests = loadConfig("interests");
  const watchedKeys = buildWatchedCompanyKeys(interests.watched_companies, pipeline);
  const notified = await listNotifiedJobIds(db, candidates.map((c) => c.jobId));
  const catalog = loadSignalCatalog();
  const selection = selectForPush(candidates, { config, watchedKeys, alreadyNotified: notified });

  const fresh = candidates.filter((c) => c.firstSeenAt.getTime() >= digest.startedAt.getTime());
  // "qualified" = a job that passed the filter and reaches the push score (the same rule as the Today page): a new job of this
  // cycle, or one scored late in it (a backlog job pushed or cut by the cap this cycle), so "0 qualified · 2 pushed" cannot happen
  const reaches = (c: PushCandidate): boolean => c.score?.filterResult === "passed" && c.score.rankValue !== null && reachesPushScore(c.score.rankValue, hasHighSignal(c), config);
  const qualifiedIds = new Set(fresh.filter(reaches).map((c) => c.jobId));
  for (const item of [...selection.selected, ...selection.overflow]) if (reaches(item.candidate)) qualifiedIds.add(item.candidate.jobId);
  const qualified = qualifiedIds.size;
  // new jobs that passed the filter but have no AI score because the usage cap held the AI back (not the ones per_cycle_limit left)
  const hold = aiQuotaHoldOf(ctx.results.ai);
  const heldBack = (c: PushCandidate): boolean => c.score?.filterResult === "passed" && c.score.score === null && (!hold || hold.heldJobIds === null || hold.heldJobIds.has(c.jobId));
  const quotaHeld = hold ? { count: fresh.filter(heldBack).length, time: hold.resumeAt ? formatLocalTime(hold.resumeAt, deps.timeZone, deps.now()) : "none" } : undefined;
  const jobs: NotifyJobsResult = {
    newJobs: fresh.length,
    passedFilter: fresh.filter((c) => c.score?.filterResult === "passed").length,
    qualified,
    pushed: 0,
    overflow: selection.overflow.length,
    failed: 0,
    skipped: selection.skipped,
  };

  try {
    const summary = await deps.client.sendMessage({
      chatId: deps.chatId,
      text: formatSummary({
        cycleKind: ctx.cycle.kind,
        at: deps.now(),
        timeZone: deps.timeZone,
        newJobs: jobs.newJobs,
        passedFilter: jobs.passedFilter,
        qualified,
        pushed: selection.selected.length,
        overflow: selection.overflow.length,
        failedSources: failedSourcesOf(ctx.results.collect),
        publicBaseUrl: config.public_base_url,
        ...(quotaHeld ? { quotaHeld } : {}),
      }, text),
    });
    await recordDigestDelivery(db, digest, {
      kind: NOTIFICATION_KINDS.cycleSummary,
      cycleId,
      payload: { newJobs: jobs.newJobs, passedFilter: jobs.passedFilter, qualified, pushed: selection.selected.length },
      sentAt: deps.now(),
      telegramMessageId: summary.messageId,
    });
  } catch (error) {
    deps.logger.error("cycle summary could not be sent", { error: describe(error) });
    jobs.failed = selection.selected.length;
    return { jobs, summarySent: false };
  }

  const sleep = deps.sleep ?? ((ms: number, signal?: AbortSignal) => delay(ms, undefined, signal ? { signal } : undefined));
  for (const [index, item] of selection.selected.entries()) {
    if (ctx.signal.aborted) {
      jobs.failed += selection.selected.length - index;
      break;
    }
    try {
      if (index > 0 && config.telegram.message_gap_ms > 0) await sleep(config.telegram.message_gap_ms, ctx.signal);
      const message = await deps.client.sendMessage({
        chatId: deps.chatId,
        text: formatJobMessage(item, text, { publicBaseUrl: config.public_base_url, traps: trapsEnabled(), catalog }),
        keyboard: jobKeyboard(item.candidate.jobId, text, { hiddenStatuses: loadHiddenSettings().statuses, resumeKit: isResumeKitConfigured() }),
      });
      await recordNotification(db, {
        kind: NOTIFICATION_KINDS.job,
        cycleId,
        payload: { jobId: item.candidate.jobId, rankValue: item.rank, reason: item.reason },
        sentAt: deps.now(),
        telegramMessageId: message.messageId,
      });
      jobs.pushed += 1;
    } catch (error) {
      jobs.failed += 1;
      deps.logger.warn("job message could not be sent", { jobId: item.candidate.jobId, error: describe(error) });
      if (ctx.signal.aborted) {
        jobs.failed += selection.selected.length - index - 1;
        break;
      }
    }
  }

  // Scored jobs cut by the cap are never pushed later ("the rest is on the dashboard"); unscored
  // watched jobs stay candidates, they may still get a score.
  for (const item of selection.overflow) {
    if (item.rank === null) continue;
    await recordNotification(db, {
      kind: NOTIFICATION_KINDS.jobOverflow,
      cycleId,
      payload: { jobId: item.candidate.jobId, rankValue: item.rank },
      sentAt: null,
    });
  }
  return { jobs, summarySent: true };
}

export function createNotifyStep(options: NotifyStepOptions = {}): CycleStepFn {
  return async (ctx): Promise<StepResult> => {
    const config = (options.loadNotifyConfig ?? (() => loadConfig("notify")))();
    if (!config.telegram.enabled) return { result: { skipped: "disabled" } satisfies NotifyStepResult };
    const db = ctx.db ?? null;
    if (db === null || ctx.cycle.id === null) return { result: { skipped: "no_database" } satisfies NotifyStepResult };
    const runtime = (options.createRuntime ?? ((c: CycleStepContext, cfg: NotifyConfig) => createTelegramRuntime({ config: cfg, logger: c.logger, signal: c.signal })))(ctx, config);
    if (runtime === null) return { status: "partial", result: { skipped: "not_configured" } satisfies NotifyStepResult };
    const savedRetry = notificationRetryOf(ctx.results.notify);
    const delivered = await hasDeliveredNotificationWindow(db, ctx.cycle.id);
    const cycle = await getCycle(db, ctx.cycle.id);
    const queuedWindow = ctx.delegatedRequestId === undefined ? null : await getRunAiNotificationWindow(db, ctx.delegatedRequestId);
    const digest = delivered ? null : await retainNotificationWindow(db, {
      cycleId: ctx.cycle.id,
      ...(ctx.delegatedRequestId === undefined ? {} : { requestId: ctx.delegatedRequestId }),
      since: savedRetry ? new Date(savedRetry.since) : new Date(ctx.now().getTime() - config.candidate_window_hours * 3_600_000),
      startedAt: savedRetry ? new Date(savedRetry.startedAt) : (queuedWindow?.startedAt ?? cycle?.startedAt ?? ctx.now()),
    });
    const retry = digest ? { ...savedRetry, since: digest.since.toISOString(), startedAt: digest.startedAt.toISOString() } : null;

    const deps: NotifyDeps = {
      db,
      client: runtime.client,
      chatId: runtime.chatId,
      config,
      timeZone: ctx.config.schedule.timezone,
      now: ctx.now,
      logger: ctx.logger,
      text: (options.notifyText ?? notifyText)(),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      signal: ctx.signal,
    };
    const result: NotifyStepResult = retry ? { retry } : {};
    let status: "ok" | "partial" = "ok";

    // 1. alerts (not held back by quiet hours unless alerts_exempt is off)
    try {
      const ai = (options.loadAiConfig ?? (() => loadConfig("ai")))();
      const input = await gatherAlertInput({
        db,
        now: ctx.now(),
        timeZone: deps.timeZone,
        channelsConfig: ctx.config.channels,
        channelBudgetUsd: (id) => ctx.channels.registry.settingsFor(id, ctx.config.channels)?.monthlyBudgetUsd,
        aiMonthlyBudgetUsd: ai.monthly_api_budget_usd,
        aiApiProviders: ai.api_order,
        budgetThresholds: config.alerts.budget_thresholds,
        collectResult: ctx.results.collect,
        aiResult: ctx.results.ai,
        aiConfig: ai,
      });
      const text = deps.text ?? notifyText();
      const quotaStore = createDbQuotaStore(db);
      const providerOf = (id: string) => AI_PROVIDER_IDS.find((p) => p === id);
      const acknowledge = async (quota: { provider: string; level: "ok" | "hard" }) => {
        const provider = providerOf(quota.provider);
        if (provider) await recordQuotaNotified(quotaStore, provider, quota.level, ctx.now());
      };
      result.alerts = await deliverAlerts(deps, [...buildAlerts(input, text), ...(await loadQueuedAlerts(db, text))], ctx.cycle.id, {
        dedupeHoursByKind: Object.fromEntries(QUOTA_ALERT_KINDS.map((kind) => [kind, ai.quota_guard.alert_dedupe_hours])),
        onHandled: async (alert) => {
          if (alert.quota) await acknowledge(alert.quota);
        },
      });
      if (input.aiQuota) for (const recovery of silentQuotaRecoveries(input.aiQuota)) await acknowledge(recovery);
      if (result.alerts.failed > 0) status = "partial";
    } catch (error) {
      status = "partial";
      ctx.logger.error("alerts could not be evaluated", { error: describe(error) });
    }

    // 2. jobs
    if (delivered) {
      result.jobs = { deferred: "already_sent" };
      delete result.retry;
      return { status, result };
    }
    if (isQuietHours(ctx.now(), deps.timeZone, config.quiet_hours)) {
      ctx.logger.info("quiet hours: job messages are held back until a later cycle");
      result.jobs = { deferred: "quiet_hours" };
      return { status, result };
    }
    if (queuedWindow?.newerPending) {
      result.jobs = { deferred: "newer_cycle_pending" };
      return { status, result };
    }
    if (digest === null) return { status, result };
    try {
      const highValue = loadHighValuePolicy();
      const candidates = await listPushCandidates(db, { since: digest.since, isHighValue: (signal) => isHighValueSignal(signal, highValue) });
      const sent = await sendJobs(deps, ctx, db, ctx.cycle.id, digest, candidates);
      result.jobs = sent.jobs;
      if (sent.summarySent) {
        delete result.retry;
        result.deliveredByCycleId = ctx.cycle.id;
      }
      if (sent.jobs.failed > 0 || !sent.summarySent) status = "partial";
    } catch (error) {
      status = "partial";
      ctx.logger.error("job notifications failed", { error: describe(error) });
    }
    return { status, result };
  };
}

export const notifyStep: CycleStepFn = createNotifyStep();

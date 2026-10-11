import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { loadHiddenSettings } from "@/lib/applications/hidden";
import { loadConfig, type NotifyConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import type { Db } from "@/lib/db/client";
import { getCycle } from "@/lib/db/repos/cycles";
import {
  hasNotificationForCycle,
  listNotifiedJobIds,
  listPushCandidates,
  NOTIFICATION_KINDS,
  recordNotification,
  type PushCandidate,
} from "@/lib/db/repos/notifications";
import type { CycleStepContext, CycleStepFn, StepResult } from "@/lib/cycle/steps";
import { resolveCompanyName } from "@/lib/pipeline/company";
import { isResumeKitConfigured } from "@/lib/resume/config";
import { isHighValueSignal } from "@/lib/signals/bonus";
import { loadHighValuePolicy, loadSignalCatalog } from "@/lib/signals/floor";

import { buildAlerts, deliverAlerts, gatherAlertInput, loadQueuedAlerts, type AlertDelivery } from "./alerts";
import { formatJobMessage, formatSummary, jobKeyboard } from "./format";
import { createTelegramRuntime, type TelegramRuntime } from "./runtime";
import { hasHighSignal, reachesPushScore, selectForPush } from "./select";
import { isTelegramError } from "./telegram-client";
import { isQuietHours } from "./time";
import { notifyText, type NotifyText } from "./text";
import type { NotifyDeps } from "./types";
import { trapsEnabled } from "@/lib/traps/settings";

/**
 * The `notify` cycle step: alerts first (they ignore quiet hours), then — unless
 * it is quiet — one summary message and one message per selected job. Jobs that were not sent stay
 * candidates for `candidate_window_hours`, so quiet hours and late scores only delay a push.
 */

export interface NotifyStepOptions {
  loadNotifyConfig?: () => NotifyConfig;
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
  /** Job messages were held back (quiet hours) or already sent for this cycle. */
  jobs?: NotifyJobsResult | { deferred: "quiet_hours" | "already_sent" };
}

const failedSourcesSchema = z.object({
  channels: z.record(z.string(), z.object({ failed: z.number().default(0), errorCodes: z.record(z.string(), z.number()).default({}) })).default({}),
  unusable: z.record(z.string(), z.string()).default({}),
});

/** Sources that failed or were given up on during collect, with their error codes. */
export function failedSourcesOf(collectResult: unknown): Array<{ channelId: string; reasons: string[] }> {
  const parsed = failedSourcesSchema.safeParse(collectResult);
  if (!parsed.success) return [];
  const result = new Map<string, Set<string>>();
  for (const [id, channel] of Object.entries(parsed.data.channels)) {
    if (channel.failed > 0) result.set(id, new Set(Object.keys(channel.errorCodes)));
  }
  for (const [id, code] of Object.entries(parsed.data.unusable)) result.set(id, (result.get(id) ?? new Set()).add(code));
  return [...result].map(([channelId, reasons]) => ({ channelId, reasons: [...reasons].sort() }));
}

function describe(error: unknown): string {
  return isTelegramError(error) ? error.message : error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "unexpected error";
}

async function sendJobs(deps: NotifyDeps, ctx: CycleStepContext, db: Db, cycleId: number, cycleStartedAt: Date, candidates: PushCandidate[]): Promise<{ jobs: NotifyJobsResult; summarySent: boolean }> {
  const { config } = deps;
  const text = deps.text ?? notifyText();
  const pipeline = loadPipeline();
  const interests = loadConfig("interests");
  const watchedKeys = new Set(interests.watched_companies.map((name) => resolveCompanyName(name, pipeline).nameNorm));
  const notified = await listNotifiedJobIds(db, candidates.map((c) => c.jobId));
  const catalog = loadSignalCatalog();
  const selection = selectForPush(candidates, { config, watchedKeys, alreadyNotified: notified });

  const fresh = candidates.filter((c) => c.firstSeenAt.getTime() >= cycleStartedAt.getTime());
  // "qualified" = a job that passed the filter and reaches the push score (the same rule as the Today page): a new job of this
  // cycle, or one scored late in it (a backlog job pushed or cut by the cap this cycle), so "0 qualified · 2 pushed" cannot happen
  const reaches = (c: PushCandidate): boolean => c.score?.filterResult === "passed" && c.score.rankValue !== null && reachesPushScore(c.score.rankValue, hasHighSignal(c), config);
  const qualifiedIds = new Set(fresh.filter(reaches).map((c) => c.jobId));
  for (const item of [...selection.selected, ...selection.overflow]) if (reaches(item.candidate)) qualifiedIds.add(item.candidate.jobId);
  const qualified = qualifiedIds.size;
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
      }, text),
    });
    await recordNotification(db, {
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
    const result: NotifyStepResult = {};
    let status: "ok" | "partial" = "ok";

    // 1. alerts (not held back by quiet hours unless alerts_exempt is off)
    try {
      const ai = loadConfig("ai");
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
      });
      const text = deps.text ?? notifyText();
      result.alerts = await deliverAlerts(deps, [...buildAlerts(input, text), ...(await loadQueuedAlerts(db, text))], ctx.cycle.id);
      if (result.alerts.failed > 0) status = "partial";
    } catch (error) {
      status = "partial";
      ctx.logger.error("alerts could not be evaluated", { error: describe(error) });
    }

    // 2. jobs
    if (isQuietHours(ctx.now(), deps.timeZone, config.quiet_hours)) {
      ctx.logger.info("quiet hours: job messages are held back until a later cycle");
      result.jobs = { deferred: "quiet_hours" };
      return { status, result };
    }
    if (await hasNotificationForCycle(db, NOTIFICATION_KINDS.cycleSummary, ctx.cycle.id)) {
      result.jobs = { deferred: "already_sent" };
      return { status, result };
    }
    try {
      const cycle = await getCycle(db, ctx.cycle.id);
      const startedAt = cycle?.startedAt ?? ctx.now();
      const since = new Date(ctx.now().getTime() - config.candidate_window_hours * 3_600_000);
      const highValue = loadHighValuePolicy();
      const candidates = await listPushCandidates(db, { since, isHighValue: (signal) => isHighValueSignal(signal, highValue) });
      const sent = await sendJobs(deps, ctx, db, ctx.cycle.id, startedAt, candidates);
      result.jobs = sent.jobs;
      if (sent.jobs.failed > 0 || !sent.summarySent) status = "partial";
    } catch (error) {
      status = "partial";
      ctx.logger.error("job notifications failed", { error: describe(error) });
    }
    return { status, result };
  };
}

export const notifyStep: CycleStepFn = createNotifyStep();

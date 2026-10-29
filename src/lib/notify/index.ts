import type { ActivityRecorder } from "@/lib/activity/types";
import type { ChannelLogger } from "@/lib/channels/types";
import { loadConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import type { Db } from "@/lib/db/client";
import { registerCycleStep } from "@/lib/cycle/steps";
import { buildWatchedCompanyKeys } from "@/lib/companies/marks";
import { prepareResumeKit } from "@/lib/resume/export";

import { aiWorkerOfflineAlert, cycleIncompleteAlert, deliverAlerts, type CycleIncompleteReason } from "./alerts";
import { createUpdateHandler, runPoller } from "./poller";
import { createReminderTicker } from "./reminders";
import { createTelegramRuntime, type RuntimeOptions } from "./runtime";
import { notifyStep } from "./step";
import { notifyText } from "./text";
import type { NotifyDeps } from "./types";

export { notifyStep, createNotifyStep } from "./step";
export { createTelegramRuntime } from "./runtime";
export type { CycleIncompleteReason } from "./alerts";

/** Plug the `notify` step into the processing cycle (called once at start-up). */
export function registerNotifySteps(): void {
  registerCycleStep("notify", notifyStep);
}

/** Normalized watched-company names of interests.yaml (matches `companies.name_norm`). */
function watchedKeys(): ReadonlySet<string> {
  const pipeline = loadPipeline();
  return buildWatchedCompanyKeys(loadConfig("interests").watched_companies, pipeline);
}

export interface PollerStartOptions extends Pick<RuntimeOptions, "env" | "fetch" | "sleep"> {
  db: Db;
  logger: ChannelLogger;
  /** Aborting stops the loop (an in-flight `getUpdates` is cancelled). */
  signal: AbortSignal;
  now?: () => Date;
  activity?: ActivityRecorder;
}

/**
 * Start the long-polling loop (inline-button presses) and the daily reminder, to be run by the
 * runner until `signal` aborts. Returns null when the credentials are missing. The loop idles while
 * `telegram.enabled` is false, so switching it on in notify.yaml takes effect without a restart.
 */
export function startNotifyPoller(options: PollerStartOptions): Promise<void> | null {
  const runtime = createTelegramRuntime({ config: loadConfig("notify"), logger: options.logger, signal: options.signal, ...(options.env ? { env: options.env } : {}), ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.sleep ? { sleep: options.sleep } : {}) });
  if (runtime === null) return null;
  const now = options.now ?? (() => new Date());
  const tick = createReminderTicker(loadConfig("notify").telegram.poll_backoff_max_seconds * 1000);
  const deps = (): NotifyDeps => ({
    db: options.db,
    activity: options.activity,
    client: runtime.client,
    chatId: runtime.chatId,
    config: loadConfig("notify"),
    timeZone: loadConfig("schedule").timezone,
    now,
    logger: options.logger,
    ...(options.sleep ? { sleep: options.sleep } : {}),
    signal: options.signal,
  });
  const handler = createUpdateHandler({
    db: options.db,
    activity: options.activity,
    client: runtime.client,
    chatId: runtime.chatId,
    allowedUserIds: runtime.allowedUserIds,
    logger: options.logger,
    getConfig: () => loadConfig("notify"),
    getWatchedKeys: watchedKeys,
    exportResume: (jobId, allowFrom) =>
      prepareResumeKit(options.db, jobId, { config: loadConfig("resume"), timeZone: loadConfig("schedule").timezone, now, source: "telegram", allowFrom }),
  });
  return runPoller({
    client: runtime.client,
    handler,
    logger: options.logger,
    getConfig: () => loadConfig("notify"),
    signal: options.signal,
    onTick: async () => {
      if (loadConfig("notify").telegram.enabled) await tick(deps());
    },
  });
}

/** Alert that a cycle did not finish (runner restart, crash, cancelled). Never throws; deduped like every alert. */
export async function sendCycleIncompleteAlert(options: {
  db: Db;
  logger: ChannelLogger;
  cycleId: number | null;
  kind: string;
  reason: CycleIncompleteReason;
  env?: RuntimeOptions["env"];
  fetch?: RuntimeOptions["fetch"];
}): Promise<void> {
  try {
    const config = loadConfig("notify");
    if (!config.telegram.enabled) return;
    const runtime = createTelegramRuntime({ config, logger: options.logger, ...(options.env ? { env: options.env } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) });
    if (runtime === null) return;
    await deliverAlerts(
      { db: options.db, client: runtime.client, chatId: runtime.chatId, config, timeZone: loadConfig("schedule").timezone, now: () => new Date(), logger: options.logger },
      [cycleIncompleteAlert({ cycleId: options.cycleId, kind: options.kind, reason: options.reason }, notifyText())],
      options.cycleId,
    );
  } catch (error) {
    options.logger.warn("could not send the cycle-incomplete alert", { error: error instanceof Error ? error.name : "unexpected error" });
  }
}

/**
 * Alert that the host ai-worker is offline. Sent by the container runner, because with the worker down
 * the notify step (which now runs in the worker) cannot. Never throws; deduped like every alert.
 */
export async function sendAiWorkerOfflineAlert(options: {
  db: Db;
  logger: ChannelLogger;
  offlineSeconds: number;
  env?: RuntimeOptions["env"];
  fetch?: RuntimeOptions["fetch"];
}): Promise<void> {
  try {
    const config = loadConfig("notify");
    if (!config.telegram.enabled) return;
    const runtime = createTelegramRuntime({ config, logger: options.logger, ...(options.env ? { env: options.env } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) });
    if (runtime === null) return;
    await deliverAlerts(
      { db: options.db, client: runtime.client, chatId: runtime.chatId, config, timeZone: loadConfig("schedule").timezone, now: () => new Date(), logger: options.logger },
      [aiWorkerOfflineAlert({ offlineSeconds: options.offlineSeconds }, notifyText())],
    );
  } catch (error) {
    options.logger.warn("could not send the ai-worker alert", { error: error instanceof Error ? error.name : "unexpected error" });
  }
}

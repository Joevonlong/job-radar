import type { CALLBACK_RESULTS } from "@/lib/activity/names";
import { activityErrorCode, noopRecorder, spanScope } from "@/lib/activity";
import type { ActivityRecorder } from "@/lib/activity/types";
import { setTimeout as delay } from "node:timers/promises";

import { loadHiddenSettings } from "@/lib/applications/hidden";
import type { ChannelLogger } from "@/lib/channels/types";
import type { NotifyConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { setApplicationStatus, type ApplicationStatus, type StatusChange } from "@/lib/db/repos/applications";
import { addFavorite, getFavorite, removeFavorite } from "@/lib/db/repos/favorites";
import { getPushCandidate } from "@/lib/db/repos/notifications";
import type { PrepareResult } from "@/lib/resume/export";
import { isResumeKitConfigured } from "@/lib/resume/config";

import { ACTION_RULES, decodeCallback, isFavoriteAction } from "./callbacks";
import { EMPTY_KEYBOARD, escapeHtml, formatJobMessage, jobKeyboard } from "./format";
import { isWatched, type PushItem } from "./select";
import { isTelegramError, type TelegramClient, type TelegramUpdate } from "./telegram-client";
import { notifyText, type NotifyText } from "./text";
import { trapsEnabled } from "@/lib/traps/settings";

/**
 * Long-polling loop: `getUpdates` in the runner, no public port needed. Only the
 * configured chat is served; everything else is ignored and logged at debug level WITHOUT its
 * content. A button press writes `applications` through the shared repo, then edits the message.
 */

export interface UpdateHandlerDeps {
  activity?: ActivityRecorder;
  db: Db;
  client: TelegramClient;
  /** `TELEGRAM_CHAT_ID`. */
  chatId: string;
  /**
   * `TELEGRAM_ALLOWED_USER_IDS`: when set, only a button press by one of these users counts, even inside the
   * configured chat (in a group chat anyone in the group could otherwise change application statuses). Unset: everyone in the chat.
   */
  allowedUserIds?: readonly number[] | null;
  logger: ChannelLogger;
  /** Fresh config per call (hot reload). */
  getConfig: () => NotifyConfig;
  /** Normalized names of the watched companies (interests.yaml), for the 👀 badge when a message is rebuilt. */
  getWatchedKeys: () => ReadonlySet<string>;
  /**
   * The 📄 button's export (the same function the dashboard button calls). It writes the JD file
   * and moves the application to `preparing` (only from `allowFrom`). Without it the button only marks `preparing`.
   */
  exportResume?: (jobId: number, allowFrom: readonly ApplicationStatus[]) => Promise<PrepareResult>;
  /** The texts in the Telegram language, read per update (language.yaml may change); default from language.yaml. */
  getText?: () => NotifyText;
}

export interface UpdateHandler {
  handle(update: TelegramUpdate): Promise<void>;
}

export type CallbackResult = (typeof CALLBACK_RESULTS)[number];

const NOT_MODIFIED = /message is not modified/i;

export function createUpdateHandler(deps: UpdateHandlerDeps): UpdateHandler {
  const { client, logger } = deps;

  const answer = async (callbackQueryId: string, text: string): Promise<void> => {
    try {
      await client.answerCallbackQuery({ callbackQueryId, text });
    } catch (error) {
      logger.debug("answerCallbackQuery failed", { error: isTelegramError(error) ? error.message : "unexpected error" });
    }
  };

  /** The command to paste into a terminal, as its own message (the edited job message has no room for it). */
  async function sendTailorCommand(exported: Extract<PrepareResult, { ok: true }>, { t }: NotifyText): Promise<void> {
    const text = exported.command ? `${escapeHtml(t("callback.runCommand"))}\n<code>${escapeHtml(exported.command)}</code>` : escapeHtml(t("callback.noResumeKit"));
    try {
      await client.sendMessage({ chatId: deps.chatId, text });
    } catch (error) {
      logger.warn("could not send the resume-kit command", { jobId: exported.jobId, error: isTelegramError(error) ? error.message : "unexpected error" });
    }
  }

  async function handleCallback(update: TelegramUpdate, text: NotifyText): Promise<CallbackResult> {
    const { t } = text;
    const query = update.callback_query;
    if (!query) return "invalid";
    const message = query.message;
    // Only buttons of messages in the configured chat count; foreign chats get no reply at all.
    if (!message || String(message.chat.id) !== deps.chatId) {
      logger.debug("ignored a callback from a foreign chat", { updateId: update.update_id });
      return "foreign_chat";
    }
    if (deps.allowedUserIds && !deps.allowedUserIds.includes(query.from.id)) {
      logger.debug("ignored a callback from a user outside TELEGRAM_ALLOWED_USER_IDS", { updateId: update.update_id });
      await answer(query.id, t("callback.notAllowed"));
      return "not_allowed";
    }
    const decoded = query.data === undefined ? null : decodeCallback(query.data);
    if (!decoded) {
      logger.debug("ignored a callback with unknown data", { updateId: update.update_id });
      await answer(query.id, t("callback.unknown"));
      return "invalid";
    }

    const candidate = await getPushCandidate(deps.db, decoded.jobId);
    if (!candidate) {
      await answer(query.id, t("callback.gone"));
      return "gone";
    }
    const item: PushItem = {
      candidate,
      watched: isWatched(candidate, deps.getWatchedKeys()),
      rank: candidate.score?.rankValue ?? null,
      reason: "threshold",
    };
    const publicBaseUrl = deps.getConfig().public_base_url;

    if (isFavoriteAction(decoded.action)) {
      // The star only touches `job_favorites`; the buttons stay, the second row flips
      const favorite = decoded.action === "favorite";
      let changed: boolean;
      if (favorite) changed = (await addFavorite(deps.db, decoded.jobId)).changed;
      else changed = (await removeFavorite(deps.db, decoded.jobId)) !== null;
      await answer(query.id, t(favorite ? (changed ? "callback.favoriteMarked" : "callback.favoriteAlready") : "callback.favoriteRemoved"));
      try {
        await client.editMessageText({
          chatId: deps.chatId,
          messageId: message.message_id,
          text: formatJobMessage(item, text, { publicBaseUrl, traps: trapsEnabled(), ...(favorite ? { markedLine: t("callback.favoriteMarked") } : {}) }),
          keyboard: jobKeyboard(decoded.jobId, text, { favorite, hiddenStatuses: loadHiddenSettings().statuses, resumeKit: isResumeKitConfigured() }),
        });
      } catch (error) {
        if (!(isTelegramError(error) && NOT_MODIFIED.test(error.description))) {
          logger.warn("could not edit the message after a star press", { jobId: decoded.jobId, error: isTelegramError(error) ? error.message : "unexpected error" });
        }
      }
      logger.info("job favorite set from Telegram", { jobId: decoded.jobId, favorite, changed });
      return changed ? "changed" : "unchanged";
    }

    const rule = ACTION_RULES[decoded.action];
    let change: StatusChange;
    let exported: Extract<PrepareResult, { ok: true }> | null = null;
    if (decoded.action === "resume" && deps.exportResume) {
      // The same export function as the dashboard button (JD file + `preparing` through the shared repo)
      const result = await deps.exportResume(decoded.jobId, rule.allowFrom);
      if (!result.ok) {
        logger.warn("could not export the JD for resume-kit", { jobId: decoded.jobId, reason: result.error });
        await answer(query.id, t(result.error === "not_found" ? "callback.gone" : "callback.exportFailed"));
        return result.error === "not_found" ? "gone" : "export_failed";
      }
      change = result.statusChange;
      exported = result;
    } else {
      // the same repo function the dashboard uses: one code path, one timeline event per change
      change = await setApplicationStatus(deps.db, decoded.jobId, rule.to, "telegram", { allowFrom: rule.allowFrom });
    }
    if (change.rejected) {
      await answer(query.id, t("callback.rejected", { status: text.status(change.previous ?? "new") }));
      return "rejected";
    }

    const marked = t(rule.marked);
    await answer(query.id, change.changed ? marked : t("callback.already", { status: text.status(rule.to) }));
    // a starred job keeps saying so under the status line
    const starred = (await getFavorite(deps.db, decoded.jobId)) !== null;
    const markedLine = [exported ? `${marked}\n${t("callback.jdPath", { path: exported.jdPath })}` : marked, ...(starred ? [t("callback.favoriteMarked")] : [])].join("\n");
    try {
      await client.editMessageText({
        chatId: deps.chatId,
        messageId: message.message_id,
        text: formatJobMessage(item, text, { publicBaseUrl, markedLine, traps: trapsEnabled() }),
        keyboard: EMPTY_KEYBOARD,
      });
    } catch (error) {
      // Pressing a button twice edits the message to what it already says.
      if (!(isTelegramError(error) && NOT_MODIFIED.test(error.description))) {
        logger.warn("could not edit the message after a button press", { jobId: decoded.jobId, error: isTelegramError(error) ? error.message : "unexpected error" });
      }
    }
    if (exported) await sendTailorCommand(exported, text);
    logger.info("job marked from Telegram", { jobId: decoded.jobId, action: decoded.action, to: change.status, changed: change.changed });
    return change.changed ? "changed" : "unchanged";
  }

  return {
    async handle(update) {
      const decoded = update.callback_query?.data === undefined ? null : decodeCallback(update.callback_query.data);
      const span = update.callback_query ? (deps.activity ?? noopRecorder).systemRoot("system.telegram_callback", decoded ? { jobId: decoded.jobId } : {}) : null;
      const scope = span ? spanScope(span) : null;
      let result: CallbackResult = "failed";
      let errorCode: string | undefined;
      let text: NotifyText | null = null;
      try {
        text = (deps.getText ?? notifyText)();
        if (update.callback_query) {
          result = await handleCallback(update, text);
          scope?.set(result === "changed" || result === "unchanged" ? "ok" : result === "export_failed" || result === "failed" ? "failed" : "skipped");
        } else if (update.message) {
          // No free-form conversation (spec: out of scope): foreign senders are logged without content, ours are dropped.
          const foreign = String(update.message.chat.id) !== deps.chatId;
          logger.debug(foreign ? "ignored a message from a foreign chat" : "ignored a text message (no conversation)", { updateId: update.update_id });
        }
      } catch (error) {
        errorCode = activityErrorCode(error);
        scope?.error(error);
        logger.error("could not handle a Telegram update", { updateId: update.update_id, error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "unexpected error" });
        const id = update.callback_query?.id;
        if (id !== undefined && update.callback_query?.message && String(update.callback_query.message.chat.id) === deps.chatId) await answer(id, (text ?? notifyText()).t("callback.error"));
      } finally {
        if (span) {
          span.item(result === "changed" || result === "unchanged" ? "item.ok" : result === "failed" || result === "export_failed" ? "item.failed" : "item.skipped", {
            ...(decoded ? { jobId: decoded.jobId } : {}), ...(errorCode ? { errorCode } : {}), params: { ...(decoded ? { action: decoded.action } : {}), result },
          });
          scope?.close();
        }
      }
    },
  };
}

export interface PollerOptions {
  client: TelegramClient;
  handler: UpdateHandler;
  logger: ChannelLogger;
  /** Fresh config per loop turn (hot reload). */
  getConfig: () => NotifyConfig;
  signal: AbortSignal;
  /** Runs after every turn of the loop (the daily reminder). Errors are logged, never fatal. */
  onTick?: () => Promise<void>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> => delay(ms, undefined, { signal });

/**
 * Run until `signal` aborts. A failed `getUpdates` waits `poll_backoff_seconds`, doubling up to
 * `poll_backoff_max_seconds`; the offset moves past a batch only after every update in it went through
 * the handler, so a crash mid-batch re-delivers it (button presses are idempotent).
 */
export async function runPoller(options: PollerOptions): Promise<void> {
  const { client, handler, logger, signal } = options;
  const sleep = options.sleep ?? defaultSleep;
  let offset: number | undefined;
  let failures = 0;

  const wait = async (ms: number): Promise<void> => {
    try {
      await sleep(ms, signal);
    } catch {
      // aborted
    }
  };

  logger.info("telegram poller started");
  while (!signal.aborted) {
    const config = options.getConfig();
    if (!config.telegram.enabled) {
      await wait(config.telegram.poll_timeout_seconds * 1000);
      continue;
    }
    try {
      const batch = await client.getUpdates({ ...(offset === undefined ? {} : { offset }), timeoutSeconds: config.telegram.poll_timeout_seconds, signal });
      failures = 0;
      if (batch.malformed > 0) logger.warn("skipped malformed Telegram updates", { count: batch.malformed });
      for (const update of batch.updates) await handler.handle(update);
      if (batch.lastUpdateId !== null) offset = batch.lastUpdateId + 1;
    } catch (error) {
      if (signal.aborted) break;
      failures += 1;
      const waitSeconds = Math.min(config.telegram.poll_backoff_seconds * 2 ** (failures - 1), config.telegram.poll_backoff_max_seconds);
      logger.warn("getUpdates failed", { error: isTelegramError(error) ? error.message : "unexpected error", retryInSeconds: waitSeconds });
      await wait(waitSeconds * 1000);
      continue;
    }
    if (options.onTick) {
      try {
        await options.onTick();
      } catch (error) {
        logger.warn("poller tick failed", { error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "unexpected error" });
      }
    }
  }
  logger.info("telegram poller stopped");
}

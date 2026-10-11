import type { ChannelLogger } from "@/lib/channels/types";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { recordNotification } from "@/lib/db/repos/notifications";
import { escapeHtml, fitLines, link, truncate } from "@/lib/notify/format";
import { createTelegramRuntime, type RuntimeOptions } from "@/lib/notify/runtime";
import { isTelegramError } from "@/lib/notify/telegram-client";
import { notifyText, type NotifyText } from "@/lib/notify/text";
import { isQuietHours } from "@/lib/notify/time";

import { suggestedValue, type SuggestionPayload } from "./suggestion";

/** `notifications.kind` of the weekly suggestion message. */
export const SUGGESTIONS_NOTIFICATION_KIND = "interest_suggestions";

/** Suggestions listed in the message; the rest is summarised as "+N more". */
const LISTED = 6;
const MAX_VALUE_CHARS = 40;

const ACTION_KEYS = { exclude_keyword: "suggestions.actionExcludeKeyword", add_location: "suggestions.actionAddLocation", exclude_company: "suggestions.actionExcludeCompany" } as const;

/** One suggestion as a line (HTML-escaped; the category id of a word is the user's own and shown as it is). */
function describeOne(payload: SuggestionPayload, { t }: NotifyText): string {
  const value = truncate(suggestedValue(payload), MAX_VALUE_CHARS);
  if (payload.kind === "signal_word") return escapeHtml(t("suggestions.word", { tier: payload.tier === "benefit_tag" ? t("suggestions.benefitTag") : payload.tier, value }));
  if (payload.kind === "watched_company") return escapeHtml(t("suggestions.watchedCompany", { value }));
  return escapeHtml(t("suggestions.action", { action: t(ACTION_KEYS[payload.action]), value }));
}

/** The weekly message (HTML): how many new suggestions, a few of them, a link to the page. Pure. */
export function formatSuggestionsMessage(input: { payloads: readonly SuggestionPayload[]; publicBaseUrl: string | null }, text: NotifyText): string {
  const { t } = text;
  const lines = [`<b>${escapeHtml(t("suggestions.title", { count: input.payloads.length }))}</b>`, escapeHtml(t("suggestions.intro"))];
  for (const payload of input.payloads.slice(0, LISTED)) lines.push(`• ${describeOne(payload, text)}`);
  if (input.payloads.length > LISTED) lines.push(escapeHtml(t("suggestions.more", { count: input.payloads.length - LISTED })));
  lines.push(input.publicBaseUrl ? link(t("suggestions.review"), `${input.publicBaseUrl.replace(/\/+$/, "")}/interests`) : escapeHtml(t("suggestions.reviewText")));
  return fitLines(lines, t("omitted"));
}

export type SuggestionsNotice = "sent" | "disabled" | "not_configured" | "quiet" | "failed";

export interface SuggestionsNoticeOptions {
  db: Db;
  logger: ChannelLogger;
  payloads: readonly SuggestionPayload[];
  now?: () => Date;
  env?: RuntimeOptions["env"];
  fetch?: RuntimeOptions["fetch"];
}

/**
 * One Telegram message for the suggestions a run just stored (the notify client, notify.yaml's switches and quiet
 * hours). Never throws: the suggestions are on the page whatever happens here, so a failure only shows in the
 * run's summary and the log.
 */
export async function sendSuggestionsNotice(options: SuggestionsNoticeOptions): Promise<SuggestionsNotice> {
  try {
    const config = loadConfig("notify");
    if (!config.telegram.enabled) return "disabled";
    const now = options.now ?? (() => new Date());
    if (isQuietHours(now(), loadConfig("schedule").timezone, config.quiet_hours)) {
      options.logger.info("suggestion notice held back by quiet hours", { count: options.payloads.length });
      return "quiet";
    }
    const runtime = createTelegramRuntime({ config, logger: options.logger, ...(options.env ? { env: options.env } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) });
    if (runtime === null) return "not_configured";
    const message = await runtime.client.sendMessage({ chatId: runtime.chatId, text: formatSuggestionsMessage({ payloads: options.payloads, publicBaseUrl: config.public_base_url }, notifyText()) });
    await recordNotification(options.db, { kind: SUGGESTIONS_NOTIFICATION_KIND, payload: { count: options.payloads.length }, sentAt: now(), telegramMessageId: message.messageId });
    return "sent";
  } catch (error) {
    options.logger.warn("suggestion notice could not be sent", { error: isTelegramError(error) ? error.message : error instanceof Error ? error.name : "unexpected error" });
    return "failed";
  }
}

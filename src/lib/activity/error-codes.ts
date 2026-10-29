import { AiProviderError, AiUnavailableError, type AiProviderErrorKind } from "@/lib/ai/errors";
import { ChannelError } from "@/lib/channels/errors";
import { CHANNEL_ERROR_CODES } from "@/lib/channels/types";
import type { BackupErrorCode } from "@/lib/ops/backup";
import { TimeoutError } from "@/lib/ops/timeout";
import { TranslationIncompleteError } from "@/lib/translation/errors";
import { REASON_CODES } from "./names";

export const AI_ERROR_CODES = ["not_configured", "auth", "rate_limited", "timeout", "network", "provider_error", "invalid_output", "budget", "aborted"] as const satisfies readonly AiProviderErrorKind[];
export const BACKUP_ERROR_CODES = ["invalid_url", "start_failed", "pg_dump_failed", "timeout", "aborted", "invalid_output", "io"] as const satisfies readonly BackupErrorCode[];
export const CONTROL_ERROR_CODES = [
  "invalid_payload", "no_handler", "handler_error", "cycle_failed", "another_cycle_running", "cycle_not_found", "config_error", "disabled", "aborted",
  "suggest_failed", "telegram_not_configured", "telegram_failed", "score_ai_unavailable", "score_failed", "score_profile_incomplete", "score_stopped",
  "rescore_ai_unavailable", "rescore_failed", "rescore_profile_incomplete", "rescore_stopped", "not_found", "no_description", "same_language", "failed",
  "no_web_provider", "quota", "not_ready", "ai_failed", "invalidPayload", "unknownChannel", "nothingStale", "nothingToScore", "databaseUnavailable", "tooSoon",
  "quota_guard", "ai_test_failed", "unknown_channel", "channel_excluded", "channel_disabled", "channel_test_failed",
  "backfillOverLimit", "cycleBusy",
] as const;
export const SAFE_ERROR_CODES = [...new Set<string>([
  ...REASON_CODES, ...CHANNEL_ERROR_CODES, ...CONTROL_ERROR_CODES, ...BACKUP_ERROR_CODES, ...AI_ERROR_CODES,
  "ai_unavailable", "translation_incomplete", "timeout", "error",
])] as readonly string[];
const safeCodes = new Set(SAFE_ERROR_CODES);

export function safeErrorCode(value: unknown): string {
  return typeof value === "string" && safeCodes.has(value) ? value : "other";
}

/** Never reads a message, cause, stack, payload or provider response. */
export function activityErrorCode(error: unknown): string {
  try {
    if (error instanceof AiProviderError) return safeErrorCode(error.kind);
    if (error instanceof AiUnavailableError) return "ai_unavailable";
    if (error instanceof TranslationIncompleteError) return "translation_incomplete";
    if (error instanceof TimeoutError) return "timeout";
    if (error instanceof ChannelError) return safeErrorCode(error.code);
    // Importing the backup implementation would pull filesystem/archive code into every caller.
    if (error instanceof Error && error.name === "BackupError" && "code" in error && BACKUP_ERROR_CODES.some((code) => code === error.code)) return safeErrorCode(error.code);
  } catch { /* Hostile error objects must not affect the work being recorded. */ }
  return "error";
}

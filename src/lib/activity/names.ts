import { z } from "zod";

export const SPAN_SCOPES = ["cycle", "request", "system"] as const;
export const PROCESSES = ["runner", "ai-worker", "cli"] as const;
export const SPAN_STATUSES = ["running", "ok", "partial", "failed", "skipped", "interrupted"] as const;
export const EVENT_LEVELS = ["info", "warn", "error"] as const;
export const SPAN_NAMES = [
  "cycle", "step.collect", "step.pipeline", "step.filter", "step.signals", "step.ai", "step.notify", "step.maintenance", "step.ai_late",
  "collect.query", "ai.score", "ai.signals", "ai.traps", "ai.translate", "ai.breakdown",
  "request.run_cycle", "request.rescore_stale", "request.run_suggest", "request.run_ai", "request.translate_job", "request.breakdown_job",
  "request.score_jobs", "request.test_channel", "request.test_ai", "request.test_telegram", "request.salary_lookup",
  "system.startup", "system.orphan_recovery", "system.backup", "system.prune", "system.delivery_prune", "system.reconcile", "system.telegram_callback", "system.reminder",
] as const;
export const EVENT_CODES = ["item.ok", "item.failed", "item.paused", "item.skipped", "parse_failed", "queries_not_reached", "cascade_reasons", "covered_by", "backfill", "orphans_marked", "spans_reconciled", "pruned", "reminder_counts", "current_scores_repaired"] as const;
export const REASON_CODES = [
  "not_recorded", "cycle_cancelled", "another_cycle_running", "covered_by_running_cycle", "backfill_over_limit", "mixed",
  "not_registered", "disabled", "not_configured", "budget_exceeded", "circuit_open",
  "delegated", "profile_incomplete", "dry_run", "no_database", "manual", "off", "no_tables",
  "quota_guard", "no_provider_available", "no_request", "other",
] as const;

export const spanScopeSchema = z.enum(SPAN_SCOPES);
export const activityProcessSchema = z.enum(PROCESSES);
export const spanStatusSchema = z.enum(SPAN_STATUSES);
export const spanNameSchema = z.enum(SPAN_NAMES);
export const eventLevelSchema = z.enum(EVENT_LEVELS);
export const eventCodeSchema = z.enum(EVENT_CODES);
export const reasonCodeSchema = z.enum(REASON_CODES);

export const CALLBACK_RESULTS = ["changed", "unchanged", "rejected", "gone", "export_failed", "foreign_chat", "not_allowed", "invalid", "failed"] as const;

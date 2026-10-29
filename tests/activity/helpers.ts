import type { ActivityLogConfig } from "@/lib/config/schemas/activity-log";

/** Tests own their settings, independently of the shipped YAML. */
export function activitySettings(): ActivityLogConfig {
  return {
    enabled: true, retention: { days: 2, max_events: 9 }, capture: { max_events_per_span: 20 },
    writer: { queue_max: 25, batch_size: 3, flush_ms: 20, connect_timeout_seconds: 1, statement_timeout_ms: 50, lock_timeout_ms: 20,
      flush_deadline_ms: 100, retry_backoff_ms: 200, shutdown_flush_ms: 80, warn_every_seconds: 1 },
    prune: { every_minutes: 1, batch_size: 2 },
    ui: { page_size: 4, events_page_size: 6, refresh_seconds: 2, default_range_days: 3, delete_budget_ms: 300 },
    liveness: { stale_after_seconds: 60, startup_grace_seconds: 30 },
  };
}

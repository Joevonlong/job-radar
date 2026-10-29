import { z } from "zod";

const positive = z.number().int().positive();

export const activityLogSchema = z.strictObject({
  // The loader validates and strips this before passing the document to the schema.
  config_version: z.literal(1).optional(),
  enabled: z.boolean(),
  retention: z.strictObject({ days: positive, max_events: positive }),
  capture: z.strictObject({ max_events_per_span: positive }),
  writer: z.strictObject({
    queue_max: positive,
    batch_size: positive,
    flush_ms: positive,
    connect_timeout_seconds: positive,
    statement_timeout_ms: positive,
    lock_timeout_ms: positive,
    flush_deadline_ms: positive,
    retry_backoff_ms: positive,
    shutdown_flush_ms: positive,
    warn_every_seconds: positive,
  }),
  prune: z.strictObject({ every_minutes: positive, batch_size: positive }),
  ui: z.strictObject({ page_size: positive, events_page_size: positive, refresh_seconds: positive, default_range_days: positive, delete_budget_ms: positive }),
  liveness: z.strictObject({ stale_after_seconds: positive, startup_grace_seconds: positive }),
}).superRefine(({ writer }, ctx) => {
  if (writer.flush_deadline_ms <= writer.statement_timeout_ms) {
    ctx.addIssue({ code: "custom", path: ["writer", "flush_deadline_ms"], message: "must exceed statement_timeout_ms" });
  }
  if (writer.batch_size > writer.queue_max) {
    ctx.addIssue({ code: "custom", path: ["writer", "batch_size"], message: "must not exceed queue_max" });
  }
});

export type ActivityLogConfig = z.infer<typeof activityLogSchema>;

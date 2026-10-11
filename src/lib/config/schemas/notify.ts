import { z } from "zod";

import { clockTime, nonNegativeInt, positiveInt, score0to100 } from "./common";

/** config/notify.yaml (config_version 2) — Telegram push thresholds, alerts and reminders. */
export const notifySchema = z.strictObject({
  telegram: z.strictObject({
    enabled: z.boolean(),
    /** Bot API root; the token is appended as `/bot<token>/<method>`. Changed only by tests / a local Bot API server. */
    api_base_url: z.url({ protocol: /^https?$/ }),
    /** Long-poll timeout of `getUpdates` (Telegram allows up to 50 s). */
    poll_timeout_seconds: z.number().int().min(1).max(50),
    /** Per-request timeout for everything but `getUpdates` (which adds its poll timeout). */
    request_timeout_seconds: positiveInt,
    /** First wait after a failed `getUpdates`; doubles up to `poll_backoff_max_seconds`. */
    poll_backoff_seconds: positiveInt,
    poll_backoff_max_seconds: positiveInt,
    /** Pause between two messages of one batch (Telegram: about one message per second per chat). */
    message_gap_ms: nonNegativeInt,
    /** Retries after a 429 / 5xx answer before a send gives up. */
    max_retries: nonNegativeInt,
  }),
  /**
   * Base URL of the web dashboard (e.g. the Tailscale address) used for the "open details" link of
   * a job message. null: messages only carry the original job link.
   */
  public_base_url: z.url({ protocol: /^https?$/ }).nullable(),
  push_min_score: score0to100,
  /** Lower threshold for postings with a high-value signal (interests.yaml categories with `high_value`; config_version 2, was `push_min_score_with_t1_t2`). */
  push_min_score_high_value: score0to100,
  max_per_cycle: positiveInt,
  /**
   * A job is a push candidate until it is this many hours old (counted from its first sighting): jobs
   * scored late, or held back by quiet hours, are still picked up by a later cycle.
   */
  candidate_window_hours: positiveInt,
  quiet_hours: z.strictObject({
    enabled: z.boolean(),
    start: clockTime,
    end: clockTime,
    /** Alerts (channel down, budget, ...) are sent even during quiet hours. */
    alerts_exempt: z.boolean(),
  }),
  alerts: z.strictObject({
    /** The same alert (kind + key) is sent at most once per this many hours. */
    dedupe_hours: positiveInt,
    /** Fractions of a monthly budget that raise an alert. */
    budget_thresholds: z
      .array(z.number().gt(0).max(1))
      .min(1)
      .refine((xs) => new Set(xs).size === xs.length, "must not contain duplicates"),
  }),
  reminders: z.strictObject({
    enabled: z.boolean(),
    /** Local time (schedule.yaml timezone) of the one daily reminder message. */
    send_at: clockTime,
    interested_days: positiveInt, // "interested" for more than N days without applying
    applied_days: positiveInt, // "applied" for more than N days without an answer
    /** Items listed per section; the rest is summarised as "+N more". */
    max_items: positiveInt,
  }),
});

export type NotifyConfig = z.infer<typeof notifySchema>;

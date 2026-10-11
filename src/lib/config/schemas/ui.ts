import { z } from "zod";

import { HIDEABLE_CONTRACTS, HIDEABLE_STATUSES, HIDEABLE_WORKPLACES } from "../../applications/visibility";

import { phraseRegexString, positiveInt } from "./common";

const noDuplicates = (items: readonly string[]): boolean => new Set(items).size === items.length;

/** What the advanced editor uses when ui.yaml has no `config_editor` block or cannot be read (so the editor can repair a broken ui.yaml). */
export const CONFIG_EDITOR_DEFAULTS = { max_bytes: 262_144, backups_keep: 20 } as const;

/** The optional web password: what the code uses when ui.yaml has no `web_access` block. */
export const WEB_ACCESS_DEFAULTS = {
  session_days: 30,
  login_max_failures: 5,
  login_window_minutes: 15,
  login_lockout_minutes: 15,
  global_max_failures: 30,
  global_delay_seconds: 2,
  max_concurrent_logins: 4,
  min_password_length: 10,
} as const;

/** When the visa badge and filter show (ui.yaml `job_checks.visa.badges`). */
export const VISA_BADGE_MODES = ["auto", "always", "never"] as const;
export type VisaBadgeMode = (typeof VISA_BADGE_MODES)[number];

/** `job_checks.visa` when ui.yaml has none. */
export const VISA_UI_DEFAULTS: { enabled: boolean; badges: VisaBadgeMode } = { enabled: true, badges: "auto" };

/** `job_checks.ghost` when ui.yaml has none: off until the owner has looked at `pnpm ghost:check --json`. */
export const GHOST_UI_DEFAULTS: { enabled: boolean; trusted_companies: string[] } = { enabled: false, trusted_companies: [] };

/** Most cycles / items any list in the interface can show (a longer strip is unreadable on a phone). */
const MAX_CYCLES = 60;
const MAX_TICKER_ITEMS = 50;

/**
 * config/ui.yaml — scales and counts used by the data-visualisation components (
 * docs/design/tokens.md "数据可视化组件"). Nothing here changes what is collected or scored.
 */
export const uiSchema = z
  .strictObject({
    /** Salary axis of the detail page and the table mini axis, in thousand EUR per year. */
    salary_axis: z
      .strictObject({
        min_k: z.number().int().min(0),
        max_k: positiveInt,
        tick_step_k: positiveInt,
      })
      .refine((axis) => axis.max_k > axis.min_k, { message: "must be larger than min_k", path: ["max_k"] })
      .refine((axis) => axis.tick_step_k < axis.max_k - axis.min_k, { message: "must be smaller than the axis (max_k - min_k)", path: ["tick_step_k"] }),
    /** Median line and percentile of the detail page: compare against this month's stated salaries only when there are at least `min_sample` of them. */
    salary_stats: z.strictObject({ min_sample: positiveInt.max(1000) }).default({ min_sample: 5 }),
    /** Freshness bar: decays to its minimum after `decay_hours` and turns yellow after `warn_hours`. */
    freshness: z
      .strictObject({
        decay_hours: positiveInt,
        warn_hours: positiveInt,
      })
      .refine((f) => f.warn_hours < f.decay_hours, { message: "must be smaller than decay_hours", path: ["warn_hours"] }),
    /** Cycles in the trend line of a summary block. */
    trend_cycles: positiveInt.min(2).max(MAX_CYCLES),
    /** Cycles in the health strip of a source. */
    health_cycles: positiveInt.max(MAX_CYCLES),
    /** Items the ticker scrolls at most. */
    ticker_max_items: positiveInt.max(MAX_TICKER_ITEMS),
    /** AI usage page (/sources/ai-usage): display settings only. */
    ai_usage: z
      .strictObject({
        default_range: z.enum(["today", "7d", "30d", "month"]),
        custom_max_days: positiveInt.max(3660),
        log_page_size: positiveInt.max(500),
        csv_max_rows: positiveInt.max(200000),
      })
      .default({ default_range: "30d", custom_max_days: 366, log_page_size: 50, csv_max_rows: 20000 }),
    /** Which application statuses the board, menus and filters show. Display only; `new` and `archived` cannot be hidden. */
    applications: z
      .strictObject({
        hidden_statuses: z.array(z.enum(HIDEABLE_STATUSES)).refine(noDuplicates, "must not contain duplicates").default([]),
      })
      .default({ hidden_statuses: [] }),
    /** Workplace / contract values the /jobs filter does not list (a link or saved view that selects one still works). */
    filters: z
      .strictObject({
        hidden_workplaces: z.array(z.enum(HIDEABLE_WORKPLACES)).refine(noDuplicates, "must not contain duplicates").default([]),
        hidden_contracts: z.array(z.enum(HIDEABLE_CONTRACTS)).refine(noDuplicates, "must not contain duplicates").default([]),
      })
      .default({ hidden_workplaces: [], hidden_contracts: [] }),
    /** The advanced config editor (/settings?tab=advanced). */
    config_editor: z
      .strictObject({
        /** Longest text the editor accepts (bytes). */
        max_bytes: positiveInt.max(4_000_000),
        /** Backups of a file kept in `<user config dir>/.backup/editor/`. */
        backups_keep: positiveInt.max(1000),
      })
      .default(CONFIG_EDITOR_DEFAULTS),
    /**
     * The optional web password (the password itself is only ever in `.env`): how long a login lasts and how failed logins
     * are limited. Protected: the web cannot change it (protected-keys.ts).
     */
    web_access: z
      .strictObject({
        /** Days a login stays valid. */
        session_days: positiveInt.max(365),
        /** Failed logins from one address within the window that lock it out. */
        login_max_failures: positiveInt.max(100),
        login_window_minutes: positiveInt.max(1440),
        login_lockout_minutes: positiveInt.max(1440),
        /**
         * Failed logins from all addresses together within the window after which every login has to wait (a guessing
         * spree that rotates its address); a browser that is still signed in is not held up.
         */
        global_max_failures: positiveInt.max(10_000),
        /** The first such wait in seconds; it doubles with each further failure, at most `login_lockout_minutes`. */
        global_delay_seconds: positiveInt.max(3600).default(WEB_ACCESS_DEFAULTS.global_delay_seconds),
        /** Password checks running at the same time at most (each needs 128 MiB for a moment); more get 429. */
        max_concurrent_logins: positiveInt.max(64),
        /** Shortest password `pnpm web:password` accepts (the doctor warns about a shorter plain-text one). */
        min_password_length: positiveInt.min(6).max(128),
      })
      .default(WEB_ACCESS_DEFAULTS),
    /**
     * Checks of a job: the recheck of watched jobs' postings (its rates and sizes are in pipeline.yaml `lifecycle.watch_recheck`),
     * signs of a ghost job and what the JD says about visa sponsorship (their limits are in pipeline.yaml `job_checks`, their
     * patterns in the market packs).
     */
    job_checks: z
      .strictObject({
        closed_recheck: z
          .strictObject({
            /** Off: watched jobs are not rechecked (the possibly-closed link check keeps running). */
            enabled: z.boolean(),
            /** Phrases (regex in the safe subset of `unsafePhraseReason`, case-insensitive) added to the market packs' `closed_posting.phrases`. */
            extra_phrases: z.array(phraseRegexString).default([]),
          })
          .default({ enabled: true, extra_phrases: [] }),
        /** The ghost job check (docs/ghost-jobs.md): a hint next to the score, never a change to it. */
        ghost: z
          .strictObject({
            /** Off (the default): nothing is computed in the cycle and no page shows it (`pnpm ghost:check` still previews). */
            enabled: z.boolean().default(GHOST_UI_DEFAULTS.enabled),
            /** Company names never flagged (compared after the same normalization as company names). */
            trusted_companies: z.array(z.string().trim().min(1).max(200)).max(500).default([]),
          })
          .default(() => ({ ...GHOST_UI_DEFAULTS, trusted_companies: [] })),
        /** The visa check (docs/visa-sponsorship.md). */
        visa: z
          .strictObject({
            /** Off: nothing is scanned and no page shows it. */
            enabled: z.boolean().default(VISA_UI_DEFAULTS.enabled),
            /**
             * The list badge and the /jobs filter: `auto` = only when me.yaml says `needs_visa_sponsorship: true`; `always`; `never`.
             * The detail page shows its line whenever the check is on.
             */
            badges: z.enum(VISA_BADGE_MODES).default(VISA_UI_DEFAULTS.badges),
          })
          .default(VISA_UI_DEFAULTS),
      })
      .default(() => ({ closed_recheck: { enabled: true, extra_phrases: [] }, ghost: { ...GHOST_UI_DEFAULTS, trusted_companies: [] }, visa: { ...VISA_UI_DEFAULTS } })),
  });

export type UiConfig = z.infer<typeof uiSchema>;

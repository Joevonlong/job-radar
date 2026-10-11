import { z } from "zod";

import { STEP_NAMES } from "@/lib/cycle/step-health";

/**
 * What `/api/shell/status` returns and the sidebar polls (a boundary, so it is parsed with zod on the client too, C6).
 * Dates are ISO strings.
 */
const iso = z.iso.datetime();
const cycleKind = z.enum(["weekday_morning", "weekday_evening", "weekend", "manual", "catchup"]);

export const shellStatusSchema = z.object({
  /** The server clock when this was read (decides "today" or a weekday for the next slot). */
  now: iso,
  /** Which of the three faces the cycle status shows. */
  state: z.enum(["idle", "running", "failed"]),
  timezone: z.string(),
  /** The next scheduled slot; null when no cycle is enabled in schedule.yaml. */
  next: z.object({ kind: cycleKind, at: iso }).nullable(),
  /** The newest cycle that ran. */
  cycle: z
    .object({
      id: z.number().int(),
      kind: cycleKind,
      status: z.enum(["running", "succeeded", "partial", "failed"]),
      /** Steps that failed / ended partial in it: a "partial" cycle says which part did not work. */
      failedSteps: z.array(z.enum(STEP_NAMES)).default([]),
      partialSteps: z.array(z.enum(STEP_NAMES)).default([]),
    })
    .nullable(),
  /** Channels of that cycle by outcome. */
  sources: z.object({ ok: z.number().int(), failed: z.number().int(), circuitOpen: z.number().int() }).nullable(),
  /** The container runner's heartbeat (same rule as /sources and the settings page: older than 3 intervals is offline). */
  runner: z.object({ online: z.boolean(), ageSeconds: z.number().int().nonnegative().nullable() }),
  /** The host ai-worker; `expected` is false when AI runs in the container (then its heartbeat means nothing). */
  aiWorker: z.object({ expected: z.boolean(), online: z.boolean(), ageSeconds: z.number().int().nonnegative().nullable() }),
  /** Nav badges: `sourcesAlert` is a warning count (channels down / open circuit / failed in the newest cycle, plus that cycle when a step failed), the others are totals. */
  counts: z.object({
    today: z.number().int().nonnegative(),
    jobs: z.number().int().nonnegative(),
    pipeline: z.number().int().nonnegative(),
    /** Starred jobs; defaults to 0 so an older response still parses. */
    favorites: z.number().int().nonnegative().default(0),
    sourcesAlert: z.number().int().nonnegative(),
  }),
  /** While running: the fetch phase (runs finished / total) or the AI phase (postings scored / total). */
  progress: z
    .object({
      phase: z.enum(["fetch", "ai"]),
      /** `pending`: the AI part waits for the ai-worker. */
      status: z.enum(["pending", "running"]),
      kind: cycleKind.nullable(),
      done: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .nullable(),
});

export type ShellStatus = z.infer<typeof shellStatusSchema>;
export type ShellCycleKind = z.infer<typeof cycleKind>;

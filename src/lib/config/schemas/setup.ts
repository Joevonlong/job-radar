import { z } from "zod";

import { SETUP_COMPLETED_BY, SETUP_STEP_IDS, SETUP_STEP_STATUSES } from "@/lib/setup/steps";

const timestamp = z.iso.datetime({ offset: true, error: "must be an ISO 8601 time, e.g. 2026-10-09T08:00:00Z" });

const stepRecord = z.strictObject({
  status: z.enum(SETUP_STEP_STATUSES),
  at: timestamp,
});

/**
 * config/setup.yaml: the state of the first-run setup. Written only by the wizard, `pnpm run setup` and the
 * start-up that recognises an install from before the setup wizard (`completed_by: existing_install`).
 * "Setup pending" = this file is readable and `completed_at` is null; an unreadable or invalid file counts as completed.
 */
export const setupSchema = z
  .strictObject({
    /** When the setup was finished (or skipped); null = not yet (pages open the wizard, scheduled cycles wait). */
    completed_at: timestamp.nullable(),
    /** How it was finished; null while it is not. */
    completed_by: z.enum(SETUP_COMPLETED_BY).nullable().default(null),
    /** What happened to each step; a step that is not listed was not reached yet. */
    steps: z.partialRecord(z.enum(SETUP_STEP_IDS), stepRecord).default({}),
  })
  .refine((value) => value.completed_at === null || value.completed_by !== null, { message: "completed_by is required once completed_at is set", path: ["completed_by"] });

export type SetupConfig = z.infer<typeof setupSchema>;

/**
 * The steps of the first-run setup (the `/setup` wizard and `pnpm run setup`), in their fixed order. Plain
 * constants without zod or server imports: the browser bundle, the config schema and the CLI share them.
 */

export const SETUP_STEP_IDS = ["language", "market", "profile", "targets", "sources", "ai", "telegram", "review"] as const;
export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

/** How a step ended: saved (`done`) or passed over without writing anything (`skipped`). */
export const SETUP_STEP_STATUSES = ["done", "skipped"] as const;
export type SetupStepStatus = (typeof SETUP_STEP_STATUSES)[number];

/** Who marked the setup complete: the web wizard, the command line, "skip the wizard", or the start-up that found an install from before the setup wizard. */
export const SETUP_COMPLETED_BY = ["wizard", "cli", "skipped", "existing_install"] as const;
export type SetupCompletedBy = (typeof SETUP_COMPLETED_BY)[number];

export function isSetupStepId(value: unknown): value is SetupStepId {
  return typeof value === "string" && (SETUP_STEP_IDS as readonly string[]).includes(value);
}

/** 0-based position of a step. */
export function stepIndex(id: SetupStepId): number {
  return SETUP_STEP_IDS.indexOf(id);
}

/** The step after `id`; null after the last one. */
export function nextStepOf(id: SetupStepId): SetupStepId | null {
  return SETUP_STEP_IDS[stepIndex(id) + 1] ?? null;
}

/** The step before `id`; null before the first one. */
export function previousStepOf(id: SetupStepId): SetupStepId | null {
  const index = stepIndex(id);
  return index <= 0 ? null : (SETUP_STEP_IDS[index - 1] ?? null);
}

/** The first step that is neither done nor skipped (the review step when every other one is). */
export function firstOpenStep(steps: Partial<Record<SetupStepId, { status: SetupStepStatus } | undefined>>): SetupStepId {
  return SETUP_STEP_IDS.find((id) => steps[id] === undefined) ?? "review";
}

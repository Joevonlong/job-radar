/** Helpers every step service shares (server only). */
import type { z } from "zod";

import { ConfigError, reloadConfig, type ConfigName, type ConfigValue } from "@/lib/config";
import type { FieldError } from "@/lib/profile/draft";
import type { ProfileActionState } from "@/lib/profile/types";

import { ensurePendingSetupFile, markStep, type SetupWriteResult } from "../state";
import type { SetupStepId } from "../steps";
import { stepError, type SetupFieldError, type SetupFormError, type SetupStepResult } from "../types";

export function profileFieldErrors(errors: readonly FieldError[]): SetupFieldError[] {
  return errors.map((error) => ({ path: error.path, ns: "profile", key: error.key, ...(error.params ? { params: error.params } : {}) }));
}

/**
 * A profile save as a step result: null when the file was written. `snapshotFailed` (the database is down: the file is
 * written, its history snapshot is recorded the next time the profile is read) counts as written.
 */
export function profileSaveProblem(step: SetupStepId, state: ProfileActionState): SetupStepResult | null {
  if (state.status !== "error") return null;
  if (state.formError === "snapshotFailed") return null;
  const formError: SetupFormError | null = state.formError === null ? null : state.formError === "dbUnavailable" || state.formError === "busy" ? state.formError : state.formError === "invalidPayload" ? "invalidPayload" : "writeFailed";
  return stepError(step, formError, profileFieldErrors(state.fieldErrors));
}

/** Read a config fresh (the web has no watcher; another process may have written it). null when it cannot be read. */
export function readFresh<N extends ConfigName>(name: N): ConfigValue<N> | null {
  try {
    return reloadConfig(name);
  } catch (error) {
    if (error instanceof ConfigError) return null;
    throw error;
  }
}

/** A mutable deep copy of a (frozen) config value. */
export function editable<T>(value: T): T {
  return structuredClone(value) as T;
}

/** zod issues of a config schema as setup field errors on `path` (the first issue per path). */
export function zodSetupErrors(error: z.ZodError, pathOf: (issuePath: ReadonlyArray<PropertyKey>) => string): SetupFieldError[] {
  const seen = new Set<string>();
  const out: SetupFieldError[] = [];
  for (const issue of error.issues) {
    const path = pathOf(issue.path);
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, ns: "setup", key: "invalid", params: { message: issue.message } });
  }
  return out;
}

/** Why a setup.yaml write failed, as the step's form error. */
export function markFailure(reason: Extract<SetupWriteResult, { ok: false }>["reason"]): SetupFormError {
  return reason === "busy" ? "busy" : reason === "db_unavailable" ? "dbUnavailable" : "setupUnreadable";
}

/** Record the step as done; a setup.yaml that cannot be written is reported (the config itself is saved). */
export async function finishStep(step: SetupStepId): Promise<SetupStepResult> {
  const marked = await markStep(step, "done");
  return marked.ok ? { status: "saved", step } : stepError(step, markFailure(marked.reason));
}

/** A refused config write as the step's form error (the CLI and the browser wizard both show it). */
export function setupWriteError(error: unknown): SetupFormError {
  if (error instanceof ConfigError && error.kind === "busy") return "busy";
  if (error instanceof ConfigError && error.kind === "db_unavailable") return "dbUnavailable";
  return "writeFailed";
}

/**
 * The shape of every step's save: the pending setup.yaml exists first, then the step's files, then the step's mark. Three
 * separate commits and no lock held around them: each file takes the file lock and then the config write lock on its own,
 * in the same order as a form save, and network work stays outside every lock. `write` returns null when everything was
 * written; a problem means the step is not marked. `onSaved` adds step-specific result fields.
 */
export async function withStepWrite(step: SetupStepId, write: () => Promise<SetupStepResult | null>, onSaved?: (result: SetupStepResult) => SetupStepResult): Promise<SetupStepResult> {
  const ensured = await ensurePendingSetupFile();
  if (!ensured.ok) return stepError(step, ensured.formError);
  const problem = await write();
  if (problem !== null) return problem;
  const result = await finishStep(step);
  return result.status === "saved" && onSaved ? onSaved(result) : result;
}

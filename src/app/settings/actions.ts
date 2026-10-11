"use server";

import { revalidatePath } from "next/cache";

import { requestRescoreStale, requestRunCycle, requestScoreJobs, type ControlActionState } from "@/lib/control/service";
import { previewAdvanced, resetAdvanced, saveAdvanced, validateAdvanced } from "@/lib/settings/advanced/service";
import type { AdvancedFileEntry, AdvancedLoad, AdvancedPreview, AdvancedResetResult, AdvancedSaveResult, AdvancedValidation } from "@/lib/settings/advanced/types";
import { loadAdvancedFile, loadAdvancedIndex } from "@/lib/settings/advanced/view";
import { saveSettings } from "@/lib/settings/service";
import { saveWorkflow } from "@/lib/settings/workflow/service";
import type { WorkflowActionState } from "@/lib/settings/workflow/types";
import type { SettingsActionState } from "@/lib/settings/types";

// Server Actions are public POST endpoints: everything arriving here is validated again in the
// services (zod), and the web server only listens on 127.0.0.1 / Tailscale (C5).

export async function saveSettingsAction(_prev: SettingsActionState, request: unknown): Promise<SettingsActionState> {
  const result = await saveSettings(request);
  // stale: the file changed elsewhere; the page reloads with the saved values (the form remounts and shows the message)
  if (result.status === "saved" || (result.status === "error" && result.formError === "stale")) revalidatePath("/settings");
  return result;
}

/** The application workflow panel: hidden statuses / categories (ui.yaml) and the reminder timeouts (notify.yaml). */
export async function saveWorkflowAction(_prev: WorkflowActionState, request: unknown): Promise<WorkflowActionState> {
  const result = await saveWorkflow(request);
  if (result.status === "saved") {
    revalidatePath("/settings");
    revalidatePath("/pipeline");
    revalidatePath("/jobs");
  }
  return result;
}

export async function runCycleAction(payload: unknown): Promise<ControlActionState> {
  return requestRunCycle(payload);
}

export async function rescoreStaleAction(): Promise<ControlActionState> {
  return requestRescoreStale();
}

/** "Score the jobs that wait for a score": `{ backlog: true }`, or `{ jobIds }` for chosen jobs. */
export async function scoreJobsAction(payload: unknown): Promise<ControlActionState> {
  return requestScoreJobs(payload);
}

// ---------------------------------------------------------------- the advanced editor
// Reads and writes of raw config text. The services validate every argument with zod again; these are only the entry points.

export async function loadAdvancedIndexAction(): Promise<AdvancedFileEntry[]> {
  return loadAdvancedIndex();
}

export async function loadAdvancedFileAction(stem: unknown): Promise<AdvancedLoad> {
  return typeof stem === "string" && stem.length <= 40 ? loadAdvancedFile(stem) : { ok: false, reason: "unknown_file" };
}

export async function validateAdvancedAction(request: unknown): Promise<AdvancedValidation> {
  return validateAdvanced(request);
}

export async function previewAdvancedAction(request: unknown): Promise<AdvancedPreview | null> {
  return previewAdvanced(request);
}

export async function saveAdvancedAction(request: unknown): Promise<AdvancedSaveResult> {
  const result = await saveAdvanced(request);
  if (result.status === "saved") revalidateAfterConfigWrite();
  return result;
}

export async function resetAdvancedAction(request: unknown): Promise<AdvancedResetResult> {
  const result = await resetAdvanced(request);
  if (result.status === "reset") revalidateAfterConfigWrite();
  return result;
}

/** A raw save can change any config: the pages that read them are refreshed. */
function revalidateAfterConfigWrite(): void {
  for (const path of ["/settings", "/pipeline", "/jobs", "/"]) revalidatePath(path);
}

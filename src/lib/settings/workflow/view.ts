/** Data for the workflow panel of /settings (server only). */
import { ConfigError, displayConfigPathForWeb, firstConfigProblem, getUserConfigPath, hashConfigText, readConfigText, reloadConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { countApplicationsByStatus } from "@/lib/db/repos/applications";

import type { WorkflowDraft, WorkflowFile, WorkflowView } from "./types";

function fileHash(name: WorkflowFile): string {
  try {
    return hashConfigText(readConfigText(name));
  } catch {
    return "";
  }
}

/** Both files' combined hash, for the panel's `key` and the stale check. */
export function workflowHash(): string {
  return hashConfigText(`${fileHash("ui")}|${fileHash("notify")}`);
}

export async function loadWorkflowView(): Promise<WorkflowView> {
  const files = { ui: displayConfigPathForWeb(getUserConfigPath("ui")), notify: displayConfigPathForWeb(getUserConfigPath("notify")) };
  let draft: WorkflowDraft | null = null;
  let loadError: WorkflowView["loadError"] = null;
  try {
    const ui = reloadConfig("ui");
    const notify = reloadConfig("notify");
    draft = {
      hiddenStatuses: [...ui.applications.hidden_statuses],
      hiddenWorkplaces: [...ui.filters.hidden_workplaces],
      hiddenContracts: [...ui.filters.hidden_contracts],
      interestedDays: String(notify.reminders.interested_days),
      appliedDays: String(notify.reminders.applied_days),
    };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    loadError = { file: error.configName === "notify" ? "notify" : "ui", message: firstConfigProblem(error) };
  }
  let counts: WorkflowView["counts"] = null;
  try {
    counts = await countApplicationsByStatus(getDb());
  } catch {
    counts = null;
  }
  return { hash: workflowHash(), draft, loadError, counts, files };
}

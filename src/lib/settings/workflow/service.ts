/**
 * Saving the application workflow panel: the hidden statuses / categories go to ui.yaml, the two reminder timeouts to
 * notify.yaml. Both files are validated first; only then ui.yaml and notify.yaml are written, one after the other. When the
 * second write fails the first stays written, and the answer says which file is still old.
 */
import { logActionFailure } from "@/lib/logging/action-failure";
import { z } from "zod";

import { HIDEABLE_CONTRACTS, HIDEABLE_STATUSES, HIDEABLE_WORKPLACES } from "@/lib/applications/visibility";
import { ConfigError, configErrorKey, mutateConfig, notifySchema, reloadConfig, uiSchema } from "@/lib/config";

import { settingsIssueKey, toNumber } from "../draft";
import type { WorkflowActionState, WorkflowField, WorkflowFieldError, WorkflowFile } from "./types";
import { workflowHash } from "./view";

const requestSchema = z.strictObject({
  hiddenStatuses: z.array(z.string().max(40)).max(40),
  hiddenWorkplaces: z.array(z.string().max(40)).max(40),
  hiddenContracts: z.array(z.string().max(40)).max(40),
  interestedDays: z.string().max(12),
  appliedDays: z.string().max(12),
});

function failed(formError: Extract<WorkflowActionState, { status: "error" }>["formError"], fieldErrors: WorkflowFieldError[] = [], failedFile: WorkflowFile | null = null): WorkflowActionState {
  return { status: "error", formError, failedFile, fieldErrors, baseHash: workflowHash() };
}

/** Only values the schema lists (a hidden list the browser sends with anything else is a validation error, not silently dropped). */
function listOf<T extends string>(values: readonly string[], allowed: readonly T[]): { ok: true; value: T[] } | { ok: false } {
  const out: T[] = [];
  for (const value of values) {
    const hit = allowed.find((item) => item === value);
    if (hit === undefined) return { ok: false };
    out.push(hit);
  }
  return { ok: true, value: out };
}

export async function saveWorkflow(rawRequest: unknown): Promise<WorkflowActionState> {
  const request = requestSchema.safeParse(rawRequest);
  if (!request.success) return failed("invalidPayload");
  const { data } = request;

  const errors: WorkflowFieldError[] = [];
  const statuses = listOf(data.hiddenStatuses, HIDEABLE_STATUSES);
  const workplaces = listOf(data.hiddenWorkplaces, HIDEABLE_WORKPLACES);
  const contracts = listOf(data.hiddenContracts, HIDEABLE_CONTRACTS);
  if (!statuses.ok) errors.push({ field: "hiddenStatuses", key: "invalidChoice" });
  if (!workplaces.ok) errors.push({ field: "hiddenWorkplaces", key: "invalidChoice" });
  if (!contracts.ok) errors.push({ field: "hiddenContracts", key: "invalidChoice" });

  const candidateUi = {
    applications: { hidden_statuses: statuses.ok ? statuses.value : [] },
    filters: { hidden_workplaces: workplaces.ok ? workplaces.value : [], hidden_contracts: contracts.ok ? contracts.value : [] },
  };
  const candidateNotify = {
    reminders: { interested_days: toNumber(data.interestedDays) ?? Number.NaN, applied_days: toNumber(data.appliedDays) ?? Number.NaN },
  };
  // Validate both sets of submitted fields before writing either file. Unedited fields are read in the write locks.
  const uiResult = z.object({ applications: uiSchema.shape.applications, filters: uiSchema.shape.filters }).safeParse(candidateUi);
  const notifyResult = z.object({ reminders: notifySchema.shape.reminders.pick({ interested_days: true, applied_days: true }) }).safeParse(candidateNotify);
  if (!uiResult.success) {
    for (const issue of uiResult.error.issues) {
      const field: WorkflowField = issue.path[0] === "filters" ? (issue.path[1] === "hidden_contracts" ? "hiddenContracts" : "hiddenWorkplaces") : "hiddenStatuses";
      errors.push({ field, ...settingsIssueKey(issue) });
    }
  }
  if (!notifyResult.success) {
    for (const issue of notifyResult.error.issues) {
      const last = issue.path[issue.path.length - 1];
      errors.push({ field: last === "applied_days" ? "appliedDays" : "interestedDays", ...settingsIssueKey(issue) });
    }
  }
  if (errors.length > 0 || !uiResult.success || !notifyResult.success) return failed(null, errors);

  // ui.yaml first, then notify.yaml: say which one did not make it
  try {
    await mutateConfig("ui", (current) => {
      // Both files must be readable before the first write; the directory lease protects this preflight too.
      reloadConfig("notify");
      return {
        ...current,
        applications: uiResult.data.applications,
        filters: { ...current.filters, hidden_workplaces: uiResult.data.filters.hidden_workplaces, hidden_contracts: uiResult.data.filters.hidden_contracts },
      };
    });
  } catch (error) {
    logActionFailure("saveWorkflow", error);
    return failed(configErrorKey(error) ?? (error instanceof ConfigError ? "unreadable" : "writeFailed"), [], "ui");
  }
  try {
    await mutateConfig("notify", (current) => ({ ...current, reminders: { ...current.reminders, ...notifyResult.data.reminders } }));
  } catch (error) {
    logActionFailure("saveWorkflow", error);
    return failed(configErrorKey(error) ?? "partial", [], "notify");
  }
  return { status: "saved", nonce: Date.now() };
}

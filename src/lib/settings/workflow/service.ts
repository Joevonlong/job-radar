/**
 * Saving the application workflow panel: the hidden statuses / categories go to ui.yaml, the two reminder timeouts to
 * notify.yaml. Both files are validated first; only then ui.yaml and notify.yaml are written, one after the other. When the
 * second write fails the first stays written, and the answer says which file is still old.
 */
import { z } from "zod";

import { HIDEABLE_CONTRACTS, HIDEABLE_STATUSES, HIDEABLE_WORKPLACES } from "@/lib/applications/visibility";
import { ConfigError, notifySchema, reloadConfig, uiSchema, writeConfig } from "@/lib/config";

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

  let ui;
  let notify;
  try {
    ui = reloadConfig("ui");
    notify = reloadConfig("notify");
  } catch (error) {
    if (error instanceof ConfigError) return failed("unreadable");
    throw error;
  }

  const errors: WorkflowFieldError[] = [];
  const statuses = listOf(data.hiddenStatuses, HIDEABLE_STATUSES);
  const workplaces = listOf(data.hiddenWorkplaces, HIDEABLE_WORKPLACES);
  const contracts = listOf(data.hiddenContracts, HIDEABLE_CONTRACTS);
  if (!statuses.ok) errors.push({ field: "hiddenStatuses", key: "invalidChoice" });
  if (!workplaces.ok) errors.push({ field: "hiddenWorkplaces", key: "invalidChoice" });
  if (!contracts.ok) errors.push({ field: "hiddenContracts", key: "invalidChoice" });

  const candidateUi = {
    ...ui,
    applications: { hidden_statuses: statuses.ok ? statuses.value : [] },
    // the other `filters` keys (the company drop-down) are not on this form: kept as they are
    filters: { ...ui.filters, hidden_workplaces: workplaces.ok ? workplaces.value : [], hidden_contracts: contracts.ok ? contracts.value : [] },
  };
  const candidateNotify = {
    ...notify,
    reminders: { ...notify.reminders, interested_days: toNumber(data.interestedDays) ?? Number.NaN, applied_days: toNumber(data.appliedDays) ?? Number.NaN },
  };
  const uiResult = uiSchema.safeParse(candidateUi);
  const notifyResult = notifySchema.safeParse(candidateNotify);
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
    await writeConfig("ui", uiResult.data);
  } catch {
    return failed("writeFailed", [], "ui");
  }
  try {
    await writeConfig("notify", notifyResult.data);
  } catch {
    return failed("partial", [], "notify");
  }
  return { status: "saved", nonce: Date.now() };
}

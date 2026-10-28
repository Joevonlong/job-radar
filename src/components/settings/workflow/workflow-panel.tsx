"use client";

import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useActionState, useEffect, useId, useState, useTransition, type FormEvent, type ReactNode } from "react";

import { saveWorkflowAction as rawSaveWorkflowAction } from "@/app/settings/actions";
import { Field } from "@/components/profile/fields";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ALL_APPLICATION_STATUSES, HIDEABLE_CONTRACTS, HIDEABLE_WORKPLACES, isHideableStatus } from "@/lib/applications/visibility";
import { columnOfStatus } from "@/lib/dashboard/board";
import type { ApplicationStatus } from "@/lib/db/repos/applications";
import { IDLE_WORKFLOW_STATE, type WorkflowDraft, type WorkflowField, type WorkflowFieldError, type WorkflowView } from "@/lib/settings/workflow/types";
import { toastTone } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { SaveBar } from "../save-bar";
import { withActionFeedback } from "@/lib/actions/client";

const saveWorkflowAction = withActionFeedback(rawSaveWorkflowAction)((previous) => previous);

/** Statuses that have a timeout of their own (notify.yaml `reminders`): the others have none (not built). */
const TIMEOUT_FIELD: Partial<Record<ApplicationStatus, "interestedDays" | "appliedDays">> = { interested: "interestedDays", applied: "appliedDays" };

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

function changedCount(a: WorkflowDraft, b: WorkflowDraft): number {
  return (
    (sameSet(a.hiddenStatuses, b.hiddenStatuses) ? 0 : 1) +
    (sameSet(a.hiddenWorkplaces, b.hiddenWorkplaces) ? 0 : 1) +
    (sameSet(a.hiddenContracts, b.hiddenContracts) ? 0 : 1) +
    (a.interestedDays === b.interestedDays ? 0 : 1) +
    (a.appliedDays === b.appliedDays ? 0 : 1)
  );
}

function toggled(list: readonly string[], value: string, shown: boolean): string[] {
  const without = list.filter((item) => item !== value);
  return shown ? without : [...without, value];
}

interface WorkflowPanelProps {
  view: WorkflowView;
  /** The runner's "loaded" line (notify.yaml: the timeouts are read by the runner and the board). */
  ack: ReactNode;
  /** Link target of the "fix it in the advanced editor" note when a file cannot be read. */
  repairHref: (file: "ui" | "notify") => string;
}

/**
 * The "application workflow" tab's own form. One status table (show / hide each of the 9 statuses, the two timeouts),
 * one card for the /jobs filter categories; ONE save that validates ui.yaml and notify.yaml first and then writes both.
 * Statuses are fixed: nothing can be added or renamed here, and hiding is display only.
 */
export function WorkflowPanel({ view, ack, repairHref }: WorkflowPanelProps) {
  const t = useTranslations("settings.workflow");
  const tc = useTranslations("settings");
  const ts = useTranslations("dashboard.status");
  const td = useTranslations("dashboard");
  const tp = useTranslations("pipeline.column");
  const base = useId();
  const [state, save, pending] = useActionState(saveWorkflowAction, IDLE_WORKFLOW_STATE);
  const [, startTransition] = useTransition();
  const initial = view.draft;
  const [draft, setDraft] = useState<WorkflowDraft | null>(initial);

  useEffect(() => {
    if (state.status === "saved") toastTone("success", tc("actions.savedToast"), { id: `workflow-${state.nonce}` });
  }, [state, tc]);

  if (view.loadError !== null || draft === null || initial === null) {
    const file = view.loadError?.file ?? "ui";
    return (
      <div role="alert" data-testid="workflow-load-error" className="border-bad bg-card flex flex-col gap-1 rounded-card border-bw px-4 py-3 text-body">
        <p className="text-bad flex items-center gap-2 font-bold [overflow-wrap:anywhere]">
          <AlertTriangle aria-hidden className="size-4 shrink-0" />
          {tc("loadError.title", { file: view.files[file] })}
        </p>
        <p className="text-ink-2">{tc("loadError.hint")}</p>
        {view.loadError ? <pre className="text-ink-2 mt-1 font-mono text-data break-words whitespace-pre-wrap">{view.loadError.message}</pre> : null}
        <Link href={repairHref(file)} className="font-bold underline underline-offset-4 hover:bg-hi hover:text-hi-ink" data-testid="repair-link">
          {tc("loadError.repair")}
        </Link>
      </div>
    );
  }

  const errors = new Map<WorkflowField, WorkflowFieldError>();
  if (state.status === "error" && state.baseHash === view.hash) for (const error of state.fieldErrors) if (!errors.has(error.field)) errors.set(error.field, error);
  const formError = state.status === "error" && state.baseHash === view.hash ? state.formError : null;
  const failedFile = state.status === "error" && state.baseHash === view.hash ? state.failedFile : null;
  const dirty = changedCount(draft, initial);
  const countOf = (status: ApplicationStatus): number | null => (view.counts === null ? null : (view.counts[status] ?? 0));
  const patch = (next: Partial<WorkflowDraft>) => setDraft({ ...draft, ...next });
  const errorText = (field: WorkflowField): string | undefined => {
    const error = errors.get(field);
    return error ? tc(`errors.${error.key}`, error.params) : undefined;
  };

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(() => save(draft));
  }

  return (
    <Card className="gap-4 py-4" data-testid="workflow-card">
      <CardHeader className="px-4 md:px-5">
        <CardTitle>
          <h2 id={`${base}-title`}>{t("title")}</h2>
        </CardTitle>
        <CardDescription className="[overflow-wrap:anywhere]">{t("description", { ui: view.files.ui, notify: view.files.notify })}</CardDescription>
      </CardHeader>
      <form noValidate aria-labelledby={`${base}-title`} onSubmit={handleSubmit}>
        <CardContent className="flex flex-col gap-6 px-4 md:px-5">
          <section className="flex flex-col gap-3" data-testid="status-table">
            <h3 className="text-title">{t("statuses.title")}</h3>
            <p className="text-ink-2 text-body-sm">{t("statuses.hint")}</p>
            <div role="table" aria-label={t("statuses.title")} className="border-border flex flex-col rounded-card border-bw">
              <div role="row" className="bg-soft text-label hidden grid-cols-[minmax(8rem,1.2fr)_minmax(6rem,1fr)_5rem_6rem_9rem] gap-3 border-b-bw border-border px-3 py-2 font-bold md:grid">
                <span role="columnheader">{t("statuses.name")}</span>
                <span role="columnheader">{t("statuses.column")}</span>
                <span role="columnheader" className="text-right">
                  {t("statuses.count")}
                </span>
                <span role="columnheader">{t("statuses.show")}</span>
                <span role="columnheader">{t("statuses.timeout")}</span>
              </div>
              {ALL_APPLICATION_STATUSES.map((status) => {
                const hideable = isHideableStatus(status);
                const shown = !draft.hiddenStatuses.includes(status);
                const count = countOf(status);
                const timeoutField = TIMEOUT_FIELD[status];
                const column = columnOfStatus(status);
                const switchId = `${base}-show-${status}`;
                const reasonId = `${base}-why-${status}`;
                const folds = !shown && count !== null && count > 0;
                return (
                  <div
                    key={status}
                    role="row"
                    data-testid={`status-row-${status}`}
                    data-hidden={shown ? "false" : "true"}
                    className="border-border grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-b-bw px-3 py-2.5 last:border-b-0 md:grid-cols-[minmax(8rem,1.2fr)_minmax(6rem,1fr)_5rem_6rem_9rem]"
                  >
                    <div role="cell" className="flex min-w-0 flex-col">
                      <span className="text-body font-bold">{ts(status === "new" ? "newFull" : status)}</span>
                      <span className="text-ink-3 text-data-sm font-mono md:hidden">
                        {column === "ended" ? tp("ended") : ts(column)} · {count === null ? "–" : count}
                      </span>
                    </div>
                    <span role="cell" className="text-ink-2 text-body-sm hidden md:block">
                      {column === "ended" ? tp("ended") : ts(column)}
                    </span>
                    <span role="cell" className="text-data hidden text-right font-mono tabular-nums md:block" data-testid={`status-count-${status}`}>
                      {count === null ? "–" : count}
                    </span>
                    <div role="cell" className="flex items-center gap-2 justify-self-end md:justify-self-start">
                      <Switch
                        id={switchId}
                        checked={shown}
                        disabled={!hideable}
                        aria-label={t("statuses.showAria", { status: ts(status === "new" ? "newFull" : status) })}
                        {...(!hideable ? { "aria-describedby": reasonId } : {})}
                        data-testid={`status-show-${status}`}
                        onCheckedChange={(checked) => patch({ hiddenStatuses: toggled(draft.hiddenStatuses, status, checked) })}
                      />
                    </div>
                    <div role="cell" className="col-span-2 flex min-w-0 flex-col gap-1 md:col-span-1">
                      {timeoutField ? (
                        <Field id={`${base}-${timeoutField}`} label={t("statuses.timeoutLabel", { status: ts(status) })} {...(errorText(timeoutField) ? { errorText: errorText(timeoutField) as string } : {})}>
                          <Input
                            id={`${base}-${timeoutField}`}
                            value={draft[timeoutField]}
                            inputMode="numeric"
                            autoComplete="off"
                            suffix={tc("units.days")}
                            className={cn("max-w-40 font-mono tabular-nums", draft[timeoutField] !== initial[timeoutField] && "bg-warn text-on-signal")}
                            aria-invalid={errorText(timeoutField) !== undefined || undefined}
                            data-testid={`status-days-${status}`}
                            onChange={(event) => patch({ [timeoutField]: event.target.value })}
                          />
                        </Field>
                      ) : (
                        <span className="text-ink-3 hidden md:block" aria-hidden>
                          –
                        </span>
                      )}
                    </div>
                    {!hideable ? (
                      <p id={reasonId} className="text-ink-3 text-body-sm col-span-2 md:col-span-5">
                        {t(status === "new" ? "statuses.whyNew" : "statuses.whyArchived")}
                      </p>
                    ) : null}
                    {folds ? (
                      <p className="text-ink-2 text-body-sm col-span-2 md:col-span-5" data-testid={`status-folds-${status}`}>
                        {t("statuses.folds", { count: count ?? 0 })}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {errorText("hiddenStatuses") ? (
              <p role="alert" className="text-bad text-body-sm font-bold">
                {errorText("hiddenStatuses")}
              </p>
            ) : null}
            <p className="text-ink-2 text-body-sm">{t("statuses.reminderNote")}</p>
          </section>

          <section className="flex flex-col gap-3" data-testid="taxonomy-card">
            <h3 className="text-title">{t("filters.title")}</h3>
            <p className="text-ink-2 text-body-sm">{t("filters.hint")}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <TaxonomyGroup
                legend={t("filters.workplaces")}
                id={`${base}-wp`}
                testPrefix="workplace"
                values={HIDEABLE_WORKPLACES}
                hidden={draft.hiddenWorkplaces}
                label={(value) => td(`workplace.${value}`)}
                onToggle={(value, shown) => patch({ hiddenWorkplaces: toggled(draft.hiddenWorkplaces, value, shown) })}
                changed={!sameSet(draft.hiddenWorkplaces, initial.hiddenWorkplaces)}
                error={errorText("hiddenWorkplaces")}
              />
              <TaxonomyGroup
                legend={t("filters.contracts")}
                id={`${base}-ct`}
                testPrefix="contract"
                values={HIDEABLE_CONTRACTS}
                hidden={draft.hiddenContracts}
                label={(value) => td(`contract.${value}`)}
                onToggle={(value, shown) => patch({ hiddenContracts: toggled(draft.hiddenContracts, value, shown) })}
                changed={!sameSet(draft.hiddenContracts, initial.hiddenContracts)}
                error={errorText("hiddenContracts")}
              />
            </div>
          </section>

          {formError ? (
            <p role="alert" data-testid="workflow-form-error" className="border-bad bg-card text-bad rounded-tag border-bw px-3 py-2 text-body-sm font-bold">
              {formError === "partial" || formError === "writeFailed"
                ? t(`formErrors.${formError}`, { file: failedFile === "notify" ? view.files.notify : view.files.ui, saved: view.files.ui })
                : t(`formErrors.${formError}`)}
            </p>
          ) : null}
        </CardContent>
        <SaveBar
          floating
          dirtyCount={dirty}
          pending={pending}
          onRevert={() => setDraft(initial)}
          status={ack}
          saveTestId="workflow-save"
          labels={{ dirty: (count) => tc("actions.dirtyCount", { count }), clean: tc("actions.clean"), save: tc("actions.save"), saving: tc("actions.saving"), revert: tc("actions.reset") }}
        />
      </form>
    </Card>
  );
}

function TaxonomyGroup<T extends string>({
  legend,
  id,
  testPrefix,
  values,
  hidden,
  label,
  onToggle,
  changed,
  error,
}: {
  legend: string;
  id: string;
  testPrefix: string;
  values: readonly T[];
  hidden: readonly string[];
  label: (value: T) => string;
  onToggle: (value: T, shown: boolean) => void;
  changed: boolean;
  error: string | undefined;
}) {
  const t = useTranslations("settings.workflow");
  return (
    <fieldset className={cn("flex min-w-0 flex-col gap-2", changed && "rounded-tag pl-3 shadow-[inset_3px_0_0_var(--warn)]")} {...(changed ? { "data-dirty": "true" } : {})}>
      <legend className="text-label mb-1 font-bold">{legend}</legend>
      {values.map((value) => (
        <div key={value} className="flex items-center gap-3">
          <Switch
            id={`${id}-${value}`}
            checked={!hidden.includes(value)}
            aria-label={t("filters.showAria", { value: label(value) })}
            data-testid={`${testPrefix}-show-${value}`}
            onCheckedChange={(checked) => onToggle(value, checked)}
          />
          <label htmlFor={`${id}-${value}`} className="text-body cursor-pointer">
            {label(value)}
          </label>
        </div>
      ))}
      {error ? (
        <p role="alert" className="text-bad text-body-sm font-bold">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

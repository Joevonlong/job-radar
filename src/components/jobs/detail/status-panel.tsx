"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { saveApplicationNotesAction, setApplicationStatusAction } from "@/app/jobs/[id]/actions";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { NOTES_MAX_CHARS } from "@/lib/dashboard/limits";
import { TermLog, type TermLine } from "@/components/viz/term-log";
import { useHiddenStatuses } from "@/components/applications/visibility-context";
import { ALL_APPLICATION_STATUSES, statusChoices } from "@/lib/applications/visibility";
import type { ApplicationStatus } from "@/lib/db/repos/applications";
import { toastTone } from "@/lib/toast";
import { cn } from "@/lib/utils";

export interface HistoryEntry {
  id: number;
  /** Time, already formatted for the viewer. */
  when: string;
  from: ApplicationStatus | null;
  to: ApplicationStatus;
  note: string | null;
}

/**
 * The status select of a job's application, saved on change (the first change creates the application). It follows the
 * server: when the status changes elsewhere (the phone bar, a key on the list) and the page re-reads, the select shows it.
 */
export function StatusSelect({ jobId, status, id, testId, className, "aria-label": ariaLabel }: { jobId: number; status: ApplicationStatus; id?: string; testId?: string; className?: string; "aria-label"?: string }) {
  const t = useTranslations("dashboard.detail.status");
  const tStatus = useTranslations("dashboard.status");
  const hidden = useHiddenStatuses();
  const [value, setValue] = useState(status);
  const [pending, startTransition] = useTransition();
  // adjust state while rendering when a prop changed (https://react.dev/learn/you-might-not-need-an-effect)
  const [seen, setSeen] = useState(status);
  if (seen !== status) {
    setSeen(status);
    setValue(status);
  }

  return (
    <NativeSelect
      {...(id ? { id } : {})}
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
      value={value}
      disabled={pending}
      className={className}
      data-testid={testId}
      onChange={(event) => {
        const next = ALL_APPLICATION_STATUSES.find((s) => s === event.target.value);
        if (!next) return;
        const previous = value;
        setValue(next);
        startTransition(async () => {
          const result = await setApplicationStatusAction({ jobId, status: next });
          if (result.ok) toastTone("success", t("saved", { status: tStatus(next === "new" ? "newFull" : next) }));
          else {
            setValue(previous);
            toastTone("error", t(`error.${result.error}`));
          }
        });
      }}
    >
      {statusChoices(value, hidden).map(({ status: s, hidden: isHidden }) => (
        <option key={s} value={s}>
          {isHidden ? t("hiddenStatus", { status: tStatus(s) }) : tStatus(s)}
        </option>
      ))}
    </NativeSelect>
  );
}

/** Id of the status select in the side panel: the header's "status and notes" button moves the focus there. */
export const STATUS_SELECT_ID = "job-status";

/**
 * "Status & notes" among the header actions: scrolls to the status panel and puts the keyboard focus on the status select,
 * so the next key press changes the status. The scroll is done here, not by the anchor jump: the jump of `href="#h-act"` resets
 * the focus to the document, so the click is taken over (`preventDefault`) whenever the select can take the focus.
 * Without script, or when the select is not shown (the phone layout keeps it in the sheet), the plain anchor still works.
 */
export function StatusJumpLink({ children, className, testId }: { children: React.ReactNode; className?: string; testId?: string }) {
  return (
    <a
      href="#h-act"
      className={className}
      data-testid={testId}
      onClick={(event) => {
        const select = document.getElementById(STATUS_SELECT_ID);
        if (!select || select.getClientRects().length === 0) return;
        event.preventDefault();
        const panel = document.getElementById("h-act")?.closest("section") ?? select;
        // behavior stays "auto": the stylesheet decides (smooth, or instant under reduced motion)
        panel.scrollIntoView?.({ block: "start" });
        select.focus({ preventScroll: true });
      }}
    >
      {children}
    </a>
  );
}

interface NotesFormProps {
  jobId: number;
  notes: string;
  /** Prefix of the element ids and test ids (the page has two forms: the panel and the phone sheet). */
  idPrefix?: string;
  /** Called after the notes were saved. */
  onSaved?: () => void;
  rows?: number;
}

/** The notes of a job's application: a textarea with its own save button (the notes are long text, never saved on blur). */
export function NotesForm({ jobId, notes, idPrefix = "job", onSaved, rows }: NotesFormProps) {
  const t = useTranslations("dashboard.detail.status");
  const [value, setValue] = useState(notes);
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState<"saved" | null>(null);
  const [seen, setSeen] = useState(notes);
  if (seen !== notes) {
    setSeen(notes);
    setValue(notes);
  }
  const dirty = value !== notes;
  const testPrefix = idPrefix === "job" ? "" : `${idPrefix}-`;

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const result = await saveApplicationNotesAction({ jobId, notes: value });
          if (result.ok) {
            setSavedAt("saved");
            toastTone("success", t("notesSaved"));
            onSaved?.();
          } else {
            toastTone("error", t(`error.${result.error}`));
          }
        });
      }}
    >
      <label htmlFor={`${idPrefix}-notes`} className="font-medium">
        {t("notes")}
      </label>
      <Textarea
        id={`${idPrefix}-notes`}
        name="notes"
        value={value}
        maxLength={NOTES_MAX_CHARS}
        rows={rows}
        onChange={(event) => {
          setValue(event.target.value);
          setSavedAt(null);
        }}
        placeholder={t("notesPlaceholder")}
        data-testid={`${testPrefix}notes-input`}
        className={cn("resize-y text-body-sm leading-normal", rows !== undefined && "min-h-0")}
      />
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending || !dirty} data-testid={`${testPrefix}notes-save`}>
          {t("saveNotes")}
        </Button>
        <span className="text-muted-foreground text-xs" role="status" data-testid={`${testPrefix}notes-state`}>
          {pending ? t("saving") : savedAt === "saved" && !dirty ? t("notesSaved") : dirty ? t("unsaved") : ""}
        </span>
      </div>
    </form>
  );
}

interface StatusPanelProps {
  jobId: number;
  status: ApplicationStatus;
  notes: string;
  history: HistoryEntry[];
  /** When the job was first seen, already formatted; the oldest line of the log. */
  firstSeen?: string;
}

/** Status select and notes of a job's application. Both save to the database; the first change creates the application. */
export function StatusPanel({ jobId, status, notes, history, firstSeen }: StatusPanelProps) {
  const t = useTranslations("dashboard.detail.status");
  const tStatus = useTranslations("dashboard.status");
  // newest first, like the terminal log of the design: status changes in amber, the first sighting dim
  const lines: TermLine[] = [
    ...history.map((entry): TermLine => ({ prefix: entry.when, tone: "amber", text: `${entry.from ? `${tStatus(entry.from)} → ` : "→ "}${tStatus(entry.to)}${entry.note ? ` · ${entry.note}` : ""}` })),
    ...(firstSeen ? [{ prefix: firstSeen, tone: "dim", text: t("firstSeen") } satisfies TermLine] : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="job-status" className="font-medium">
          {t("label")}
        </label>
        <StatusSelect jobId={jobId} status={status} id={STATUS_SELECT_ID} testId="status-select" />
      </div>

      <NotesForm jobId={jobId} notes={notes} />

      {history.length > 0 || firstSeen ? (
        <div className="border-grid border-t-[1.5px] pt-3" data-testid="status-history">
          <h3 className="text-cap text-ink-3 text-cap-style mb-2">{t("history")}</h3>
          <TermLog lines={lines} />
        </div>
      ) : null}
    </div>
  );
}

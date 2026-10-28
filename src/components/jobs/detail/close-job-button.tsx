"use client";

import { CircleSlash2, Pencil, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type ReactNode } from "react";

import { closeJobAction as rawCloseJobAction, reopenJobAction as rawReopenJobAction, undoClosureAction as rawUndoClosureAction, type ClosureActionResult } from "@/app/jobs/closure-actions";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { CLOSURE_NOTE_MAX, type ClosedReason } from "@/lib/jobs/closure";
import { toastTone, toastUndo } from "@/lib/toast";
import { withActionFeedback } from "@/lib/actions/client";

const closeJobAction = withActionFeedback(rawCloseJobAction)(() => ({ ok: false, error: "failed" }));
const reopenJobAction = withActionFeedback(rawReopenJobAction)(() => ({ ok: false, error: "failed" }));
const undoClosureAction = withActionFeedback(rawUndoClosureAction)(() => ({ ok: false }));

interface ClosureProps {
  jobId: number;
  title: string;
  /** Why the job shows as (possibly) closed now; null = open. */
  reason: ClosedReason | null;
  /** The note of the user's own close (the form starts from it). */
  note: string | null;
}

/** The save / undo behaviour shared by the buttons: refresh, then a toast whose undo puts back the judgement before the change. */
function useClosure({ jobId, title }: Pick<ClosureProps, "jobId" | "title">) {
  const t = useTranslations("dashboard.closed");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function after(result: ClosureActionResult, message: string) {
    if (!result.ok) {
      toastTone("error", t("failed"));
      return;
    }
    router.refresh();
    const previous = result.previous;
    toastUndo(message, async () => {
      const undone = await undoClosureAction({ jobId, previous });
      if (undone.ok) router.refresh();
      else toastTone("error", t("failed"));
    });
  }

  const close = (note: string, done: () => void) =>
    startTransition(async () => {
      const result = await closeJobAction({ jobId, note });
      done();
      after(result, t("closedToast", { title }));
    });
  const reopen = (message: "reopenedToast" | "keptOpenToast") =>
    startTransition(async () => {
      after(await reopenJobAction({ jobId }), t(message, { title }));
    });
  return { pending, close, reopen };
}

/** The "mark as closed" form (an optional note, up to 200 characters) behind any trigger. */
function CloseForm({ trigger, note, pending, submitLabel, onSubmit }: { trigger: ReactNode; note: string | null; pending: boolean; submitLabel: string; onSubmit: (note: string, done: () => void) => void }) {
  const t = useTranslations("dashboard.closed");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(note ?? "");
  const noteId = useId();
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setDraft(note ?? "");
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2">
        <label htmlFor={noteId} className="text-body-sm font-semibold">
          {t("noteLabel")}
        </label>
        <Textarea
          id={noteId}
          value={draft}
          maxLength={CLOSURE_NOTE_MAX}
          placeholder={t("notePlaceholder")}
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
          data-testid="detail-close-note"
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
            {t("cancel")}
          </Button>
          <Button type="button" variant="primary" size="sm" disabled={pending} onClick={() => onSubmit(draft, () => setOpen(false))} data-testid="detail-close-submit">
            {submitLabel}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The one closure button of the detail page's action row: "Reopen" for a job closed by the user or taken down at the source,
 * else "Mark as closed" ("Confirm closed" when the checks only marked it possibly closed) with its note form. Every change offers an
 * undo. The answers that belong to the evidence ("Still open", editing the note) sit with it, under the header (`ClosureAnswers`).
 */
export function CloseJobButton({ jobId, title, reason, note }: ClosureProps) {
  const t = useTranslations("dashboard.closed");
  const { pending, close, reopen } = useClosure({ jobId, title });
  if (reason === "manual" || reason === "gone") {
    return (
      <Button type="button" variant="outline" size="md" disabled={pending} onClick={() => reopen("reopenedToast")} data-testid="detail-reopen">
        <RotateCcw aria-hidden /> {t("reopen")}
      </Button>
    );
  }
  const possibly = reason === "phrase" || reason === "possibly";
  return (
    <CloseForm
      note={note}
      pending={pending}
      submitLabel={t("submit")}
      onSubmit={close}
      trigger={
        <Button type="button" variant="outline" size="md" disabled={pending} data-testid="detail-close">
          <CircleSlash2 aria-hidden /> {possibly ? t("confirmClosed") : t("markClosed")}
        </Button>
      }
    />
  );
}

/** The answers next to the closure evidence: "Still open" for a possibly closed job, "Edit note" for one the user closed. */
export function ClosureAnswers({ jobId, title, reason, note }: ClosureProps) {
  const t = useTranslations("dashboard.closed");
  const { pending, close, reopen } = useClosure({ jobId, title });
  if (reason === "phrase" || reason === "possibly") {
    return (
      <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => reopen("keptOpenToast")} data-testid="detail-keep-open">
        <RotateCcw aria-hidden /> {t("keepOpen")}
      </Button>
    );
  }
  if (reason !== "manual") return null;
  return (
    <CloseForm
      note={note}
      pending={pending}
      submitLabel={t("saveNote")}
      onSubmit={close}
      trigger={
        <Button type="button" variant="outline" size="sm" disabled={pending} data-testid="detail-edit-note">
          <Pencil aria-hidden /> {note ? t("editNote") : t("addNote")}
        </Button>
      }
    />
  );
}

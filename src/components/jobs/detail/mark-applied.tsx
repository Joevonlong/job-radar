"use client";

import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";

import { markAppliedAction } from "@/app/jobs/[id]/actions";
import { undoApplicationStatusAction } from "@/app/pipeline/actions";
import { useHiddenStatuses } from "@/components/applications/visibility-context";
import { isStatusOffered } from "@/lib/applications/visibility";
import { buttonVariants } from "@/components/ui/button";
import { MARK_APPLIED_FROM } from "@/lib/dashboard/apply";
import type { ApplicationStatus } from "@/lib/db/repos/applications";
import { toastTone, toastUndo } from "@/lib/toast";
import { cn } from "@/lib/utils";

interface MarkAppliedButtonProps {
  jobId: number;
  title: string;
  status: ApplicationStatus;
  /** When the application was marked applied, already formatted for the viewer (a string: it crosses from the server page); null when unknown. */
  appliedOn: string | null;
  /** "header": the desktop action row; "bar": the phone bar (two equal halves). */
  variant: "header" | "bar";
  /** Prefix of the test ids: "" gives `mark-applied-button`, "bar-" gives `bar-mark-applied-button`. */
  testIdPrefix?: string;
}

/**
 * "Mark applied": the explicit act after the user really applied. Opening the posting changes nothing; only this
 * button writes `applied` (with an Undo toast). Once applied it turns into a read-only display; statuses further along
 * show their name. Follows the server status through props.
 */
export function MarkAppliedButton({ jobId, title, status, appliedOn, variant, testIdPrefix = "" }: MarkAppliedButtonProps) {
  const t = useTranslations("dashboard.detail.markApplied");
  const tStatus = useTranslations("dashboard.status");
  const [pending, startTransition] = useTransition();
  const hidden = useHiddenStatuses();
  const size = variant === "bar" ? "h-ctl-md min-w-0 flex-1 px-2" : "h-ctl-md";

  if (!MARK_APPLIED_FROM.includes(status)) {
    return (
      <span
        className={cn("rounded-pill bg-ink text-paper text-data inline-flex items-center justify-center gap-1.5 px-3 font-mono font-bold whitespace-nowrap", size)}
        data-testid={`${testIdPrefix}applied-display`}
        data-status={status}
      >
        <Check aria-hidden className="size-4" />
        {status === "applied" ? (appliedOn ? t("display", { date: appliedOn }) : tStatus("applied")) : tStatus(status)}
      </span>
    );
  }

  // `applied` is hidden in ui.yaml: no button (the server still accepts the move)
  if (!isStatusOffered("applied", hidden)) return null;

  const mark = () =>
    startTransition(async () => {
      const result = await markAppliedAction({ jobId });
      if (!result.ok) {
        toastTone("error", t(`error.${result.error}`));
        return;
      }
      if (!result.changed) {
        toastTone("info", t("already"));
        return;
      }
      const restoreTo: ApplicationStatus = result.previous ?? "new";
      toastUndo(t("marked", { title }), async () => {
        const undone = await undoApplicationStatusAction({ jobId, movedTo: "applied", restoreTo });
        if (undone.ok) toastTone("success", t("undone", { status: tStatus(restoreTo === "new" ? "newFull" : restoreTo) }));
        else toastTone("error", t("error.failed"));
      });
    });

  return (
    <button
      type="button"
      className={cn(buttonVariants({ variant: "outline" }), size)}
      disabled={pending}
      aria-busy={pending}
      onClick={mark}
      data-testid={`${testIdPrefix}mark-applied-button`}
    >
      <Check aria-hidden /> {t("label")}
    </button>
  );
}

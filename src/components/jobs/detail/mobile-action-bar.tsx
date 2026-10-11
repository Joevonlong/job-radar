"use client";

import { ExternalLink, NotebookPen } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { FavoriteButton } from "@/components/favorites/favorite-button";
import { Button, buttonVariants } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { ApplicationStatus } from "@/lib/db/repos/applications";
import { cn } from "@/lib/utils";

import { MarkAppliedButton } from "./mark-applied";
import { PostingLink } from "./posting-link";
import { NotesForm, StatusSelect } from "./status-panel";

interface MobileActionBarProps {
  jobId: number;
  status: ApplicationStatus;
  notes: string;
  title: string;
  /** Where "View posting" goes; null when the job has no usable link. */
  postingUrl: string | null;
  /** When it was marked applied (formatted), for the read-only display. */
  appliedOn: string | null;
  /** The job is starred. */
  favorite: boolean;
}

/**
 * The actions of the detail page for a phone: status, notes, "View posting" and "Mark applied" in a bar fixed to the bottom, so a job
 * opened from a Telegram link can be marked without scrolling through the whole description. The status select saves
 * on change like the one in the side panel; the notes open in a bottom sheet. Hidden from `lg` up, where the side
 * panel is next to the text.
 */
export function MobileActionBar({ jobId, status, notes, title, postingUrl, appliedOn, favorite }: MobileActionBarProps) {
  const t = useTranslations("dashboard.detail");
  const [open, setOpen] = useState(false);
  const hasNotes = notes.trim() !== "";

  return (
    <>
      <div
        className="border-border bg-background/95 supports-[backdrop-filter]:bg-background/80 fixed inset-x-0 bottom-0 z-40 flex flex-col gap-2 border-t px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur md:left-60 lg:hidden"
        role="region"
        aria-label={t("actionBar.label")}
        data-testid="mobile-action-bar"
        data-bottom-bar
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <StatusSelect jobId={jobId} status={status} aria-label={t("status.label")} testId="bar-status-select" className="h-[44px]" />
          </div>
          <Button type="button" variant="outline" size="icon" className="relative size-[44px] shrink-0" aria-label={t("actionBar.notes")} onClick={() => setOpen(true)} data-testid="bar-notes-button">
            <NotebookPen aria-hidden />
            {hasNotes ? <span aria-hidden className="bg-primary absolute top-1 right-1 size-2 rounded-full" /> : null}
          </Button>
          <FavoriteButton jobId={jobId} title={title} favorite={favorite} variant="icon" />
        </div>
        <div className="flex items-center gap-2">
          {postingUrl ? (
            <PostingLink jobId={jobId} href={postingUrl} className={cn(buttonVariants({ variant: "primary" }), "h-ctl-md min-w-0 flex-1 px-2")} testId="bar-view-posting-button">
              {t("actionBar.viewPosting")} <ExternalLink aria-hidden />
            </PostingLink>
          ) : (
            <span aria-disabled="true" className={cn(buttonVariants({ variant: "outline" }), "pointer-events-none h-ctl-md min-w-0 flex-1 px-2 opacity-50")}>
              {t("noPostingLink")}
            </span>
          )}
          <MarkAppliedButton jobId={jobId} title={title} status={status} appliedOn={appliedOn} variant="bar" testIdPrefix="bar-" />
        </div>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[85dvh] gap-3 rounded-t-xl pb-[max(1rem,env(safe-area-inset-bottom))]" data-testid="bar-notes-sheet">
          <SheetHeader className="pb-0">
            <SheetTitle>{t("actionBar.notes")}</SheetTitle>
            <SheetDescription className="sr-only">{t("actionBar.notesHint")}</SheetDescription>
          </SheetHeader>
          <div className="overflow-y-auto px-4">
            <NotesForm jobId={jobId} notes={notes} idPrefix="bar" rows={6} onSaved={() => setOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

"use client";

import { Check, MoreHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useHiddenStatuses } from "@/components/applications/visibility-context";
import { statusChoices } from "@/lib/applications/visibility";
import type { ApplicationStatus } from "@/lib/db/repos/applications";

interface CardMoveMenuProps {
  jobId: number;
  company: string;
  status: ApplicationStatus;
  onMove: (jobId: number, status: ApplicationStatus) => void;
}

/**
 * "Move to…": the compact replacement for the status select that used to sit on every card. A small icon button that opens
 * the list of statuses (the current one is ticked). Touch screens use it; so can the keyboard (Enter opens it, arrows pick),
 * next to the keyboard drag on the handle.
 */
export function CardMoveMenu({ jobId, company, status, onMove }: CardMoveMenuProps) {
  const t = useTranslations("pipeline");
  const ts = useTranslations("dashboard.status");
  const choices = statusChoices(status, useHiddenStatuses());
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        type="button"
        aria-label={t("card.moveFor", { company })}
        data-testid="card-status"
        data-status={status}
        className="text-ink-2 hover:bg-hi/60 hover:text-ink rounded-tag inline-grid size-11 shrink-0 md:size-7 place-items-center"
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40" data-testid="card-move-menu">
        <DropdownMenuLabel className="text-ink-2 px-2.5 py-1 text-xs font-medium">{t("card.moveTo")}</DropdownMenuLabel>
        {choices.map(({ status: s, hidden }) => (
          <DropdownMenuItem key={s} data-testid={`card-move-${s}`} aria-current={s === status ? "true" : undefined} onSelect={() => (s === status ? undefined : onMove(jobId, s))}>
            <span className="flex-1">{hidden ? t("card.hiddenStatus", { status: ts(s) }) : ts(s)}</span>
            {s === status ? <Check aria-hidden className="size-4" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

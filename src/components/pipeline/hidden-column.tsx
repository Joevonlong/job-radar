"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";

import type { ApplicationStatus } from "@/lib/db/repos/applications";
import type { BoardDensity } from "@/lib/dashboard/density";
import { cn } from "@/lib/utils";

import { columnClass } from "./board-column";
import { DraggableCard } from "./card";
import { ColumnScroll } from "./column-scroll";
import { COLUMN_COLOR } from "./status-colors";
import type { BoardCard } from "./types";

interface HiddenColumnProps {
  status: Exclude<keyof typeof COLUMN_COLOR, "ended">;
  cards: readonly BoardCard[];
  open: boolean;
  pushLine: number;
  density: BoardDensity;
  settleId: number | null;
  onToggle: () => void;
  onOpen: (jobId: number) => void;
  onMove: (jobId: number, status: ApplicationStatus) => void;
}

/**
 * A status the user hid in settings that still holds cards. Collapsed it is a narrow strip, "In interviews · hidden · 2";
 * opened it lists the cards (they stay draggable out and have the move menu) but is not a drop target: nothing can be moved in.
 */
export function HiddenColumn({ status, cards, open, density, pushLine, settleId, onToggle, onOpen, onMove }: HiddenColumnProps) {
  const ts = useTranslations("dashboard.status");
  const t = useTranslations("pipeline.hiddenColumn");
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section
      aria-label={t("label", { status: ts(status), count: cards.length })}
      data-testid="board-column"
      data-column={status}
      data-hidden-column={open ? "open" : "collapsed"}
      className={cn(open ? columnClass : "bg-soft border-bw border-ink rounded-card gap-sp-2 p-sp-2 flex w-36 shrink-0 snap-start flex-col")}
    >
      <button type="button" aria-expanded={open} onClick={onToggle} className="rounded-tag flex shrink-0 flex-col gap-1 text-left" data-testid={`hidden-toggle-${status}`}>
        <span className="text-label flex items-center gap-1.5 font-extrabold">
          <i aria-hidden className={cn("border-ink rounded-cell size-3 shrink-0 border-2", COLUMN_COLOR[status].dot)} />
          <Chevron aria-hidden className="text-ink-3 size-4 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{ts(status)}</span>
        </span>
        <span className="text-ink-3 text-data-sm font-mono">{t("summary", { count: cards.length })}</span>
      </button>
      {open ? (
        <ColumnScroll label={ts(status)}>
          <div role="group" aria-label={ts(status)} data-testid={`hidden-cards-${status}`} className="gap-sp-2 flex flex-col">
            {cards.map((card) => (
              <DraggableCard key={card.jobId} card={card} density={density} pushLine={pushLine} settling={settleId === card.jobId} onOpen={onOpen} onMove={onMove} />
            ))}
          </div>
        </ColumnScroll>
      ) : null}
    </section>
  );
}

"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";

import { PercentBar } from "@/components/viz";
import { useAppLocale } from "@/components/viz/intl";
import type { ApplicationStatus } from "@/lib/db/repos/applications";
import type { BoardDensity } from "@/lib/dashboard/density";
import { formatInteger, ratioPercent } from "@/lib/format/numbers";

import { ColumnHead, columnClass, DropZone } from "./board-column";
import { DraggableCard } from "./card";
import { ColumnScroll } from "./column-scroll";
import type { BoardCard } from "./types";

interface EndedColumnProps {
  cards: readonly BoardCard[];
  /** A card is being dragged: the collapsed column shows its drop zones. */
  dragging: boolean;
  open: boolean;
  pushLine: number;
  density: BoardDensity;
  settleId: number | null;
  onToggle: () => void;
  onOpen: (jobId: number) => void;
  onMove: (jobId: number, status: ApplicationStatus) => void;
  /** The statuses that get a drop zone (the hidden ones are left out). */
  zones: readonly EndedStatus[];
  /** Hidden statuses that still hold cards: listed when the column is open, but nothing can be dropped on them. */
  hiddenWithCards: readonly EndedStatus[];
}

type EndedStatus = "rejected" | "withdrawn" | "archived";
const ENDED_ORDER: readonly EndedStatus[] = ["rejected", "withdrawn", "archived"];

/**
 * Rejected, withdrawn and ignored jobs share one column that is collapsed by default: a count bar per outcome (the
 * share of the ended jobs), and "expand" for the cards. Dragging a card shows the three drop zones, one per status,
 * so the drop says which end state is meant.
 */
export function EndedColumn({ cards, dragging, open, density, pushLine, settleId, onToggle, onOpen, onMove, zones, hiddenWithCards }: EndedColumnProps) {
  const t = useTranslations("pipeline.column");
  const ts = useTranslations("dashboard.status");
  const locale = useAppLocale();
  const showZones = open || dragging;
  const Chevron = open ? ChevronDown : ChevronRight;
  const countOf = (status: ApplicationStatus) => cards.filter((card) => card.status === status).length;
  // the statuses the column lists, in its order: those with a drop zone, and hidden ones that still hold cards
  const listed = ENDED_ORDER.filter((status) => zones.includes(status) || hiddenWithCards.includes(status));
  const share = (count: number) => ratioPercent(count, cards.length);

  return (
    <section aria-label={t("ended")} data-testid="board-column" data-column="ended" className={columnClass}>
      <button type="button" aria-expanded={open} onClick={onToggle} className="min-h-sp-6 shrink-0 rounded-tag text-left" data-testid="ended-toggle">
        <ColumnHead column="ended" label={t("ended")} count={cards.length}>
          <Chevron aria-hidden className="text-ink-3 size-4" />
        </ColumnHead>
      </button>
      {showZones ? (
        <ColumnScroll label={t("ended")}>
          <div className="flex flex-col gap-sp-2">
            {listed.map((status) => {
              const inStatus = cards.filter((card) => card.status === status);
              const dropTarget = zones.includes(status);
              return (
                <div key={status} className="flex flex-col gap-1">
                  <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-sp-2 px-0.5">
                    <span className="text-body-sm">{dropTarget ? ts(status) : t("hiddenSuffix", { status: ts(status) })}</span>
                    <PercentBar value={share(inStatus.length)} size="sm" tone="ink" label={formatInteger(inStatus.length, locale)} ariaLabel={t("endedCount", { status: ts(status), count: inStatus.length })} className="w-full" />
                  </div>
                  {dropTarget ? (
                    <DropZone id={status} label={ts(status)} testId={`drop-${status}`}>
                      {open ? inStatus.map((card) => <DraggableCard key={card.jobId} card={card} density={density} pushLine={pushLine} settling={settleId === card.jobId} onOpen={onOpen} onMove={onMove} />) : null}
                    </DropZone>
                  ) : open ? (
                    <div role="group" aria-label={ts(status)} data-testid={`hidden-cards-${status}`} className="gap-sp-2 flex flex-col">
                      {inStatus.map((card) => <DraggableCard key={card.jobId} card={card} density={density} pushLine={pushLine} settling={settleId === card.jobId} onOpen={onOpen} onMove={onMove} />)}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </ColumnScroll>
      ) : (
        <>
          <ul aria-label={t("endedBars")} className="flex flex-col gap-1.5 px-0.5">
            {listed.map((status) => {
              const count = countOf(status);
              return (
                <li key={status} className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-sp-2">
                  <span className="text-body-sm">{zones.includes(status) ? ts(status) : t("hiddenSuffix", { status: ts(status) })}</span>
                  <PercentBar value={share(count)} size="sm" tone="ink" label={formatInteger(count, locale)} ariaLabel={t("endedCount", { status: ts(status), count })} className="w-full" />
                </li>
              );
            })}
          </ul>
          {cards.length > 0 ? <span className="text-ink-3 text-data-sm px-0.5 font-mono">{t("endedHint")}</span> : null}
        </>
      )}
    </section>
  );
}

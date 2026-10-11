"use client";

import { useDroppable } from "@dnd-kit/core";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { PercentBar } from "@/components/viz";
import type { BoardColumn as ColumnId } from "@/lib/dashboard/board";
import type { ApplicationStatus } from "@/lib/db/repos/applications";
import { formatPercent, ratioPercent } from "@/lib/format/numbers";
import { cn } from "@/lib/utils";

import { DraggableCard } from "./card";
import { COLUMN_COLOR } from "./status-colors";
import type { BoardCard } from "./types";

// Every column is the same width, empty or not, the ended one included (design "申请看板"). Phones: one column per swipe. From md up the
// columns share the row; when they would get narrower than `md:min-w-[14rem]` the board scrolls sideways inside its own container.
export const columnClass =
  "bg-soft border-bw border-ink rounded-card flex w-[78vw] max-w-[300px] min-w-0 shrink-0 snap-start flex-col gap-sp-2 p-sp-2 md:w-0 md:min-w-[14rem] md:max-w-none md:flex-1";

/** A drop target: the zone turns highlight-yellow while a card is over it. */
export function DropZone({ id, label, testId, children }: { id: ApplicationStatus; label: string; testId: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} role="group" aria-label={label} data-testid={testId} data-over={isOver ? "true" : undefined} className={cn("rounded-tag gap-sp-2 flex min-h-12 flex-col transition-colors", isOver && "bg-hi/40 ring-ink ring-2")}>
      {children}
    </div>
  );
}

/** Column head: the status colour square, the name and the count. */
export function ColumnHead({ column, label, count, children }: { column: ColumnId; label: string; count: number; children?: ReactNode }) {
  return (
    <div className="text-label flex items-center gap-1.5 px-0.5 pt-0.5 font-extrabold">
      <i aria-hidden className={cn("border-ink rounded-cell size-3 shrink-0 border-2", COLUMN_COLOR[column].dot)} />
      <span className="flex min-w-0 items-center gap-1">
        {children}
        {label}
      </span>
      <span className="text-data ml-auto font-mono leading-none font-medium tabular-nums" data-testid="column-count">
        {count}
      </span>
    </div>
  );
}

function Empty() {
  const t = useTranslations("pipeline.column");
  return <div className="text-ink-3 border-grid text-data-sm rounded-card border-bw px-sp-2 py-sp-4 border-dashed text-center font-mono">{t("empty")}</div>;
}

interface StatusColumnProps {
  status: Exclude<ColumnId, "ended">;
  cards: readonly BoardCard[];
  /** Cards on the board (after filters): the column's share is `cards.length / total`. */
  total: number;
  pushLine: number;
  settleId: number | null;
  onOpen: (jobId: number) => void;
  onMove: (jobId: number, status: ApplicationStatus) => void;
}

/** A column of one status: head, share-of-pipeline bar, drop zone with the cards. */
export function StatusColumn({ status, cards, total, pushLine, settleId, onOpen, onMove }: StatusColumnProps) {
  const ts = useTranslations("dashboard.status");
  const t = useTranslations("pipeline.column");
  const share = ratioPercent(cards.length, total);
  const percent = formatPercent(share);
  return (
    <section aria-label={ts(status)} data-testid="board-column" data-column={status} className={columnClass}>
      <ColumnHead column={status} label={ts(status)} count={cards.length} />
      <PercentBar value={share} size="sm" tone={COLUMN_COLOR[status].tone} label={percent} ariaLabel={t("shareAria", { name: ts(status) })} className="w-full" />
      <DropZone id={status} label={ts(status)} testId={`drop-${status}`}>
        {cards.length === 0 ? <Empty /> : cards.map((card) => <DraggableCard key={card.jobId} card={card} pushLine={pushLine} settling={settleId === card.jobId} onOpen={onOpen} onMove={onMove} />)}
      </DropZone>
    </section>
  );
}

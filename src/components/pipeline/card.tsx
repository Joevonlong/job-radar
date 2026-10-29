"use client";

import { useDraggable } from "@dnd-kit/core";
import { GripVertical } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { FavoriteMark } from "@/components/favorites/favorite-mark";
import { JobStatusChip, StatusChip } from "@/components/jobs/status-chip";
import { motion, ScoreMeter, useReducedMotion } from "@/components/viz";
import { isEndedStatus } from "@/lib/dashboard/board";
import type { ApplicationStatus } from "@/lib/db/repos/applications";
import type { BoardDensity } from "@/lib/dashboard/density";
import { cn } from "@/lib/utils";

import { CardMoveMenu } from "./card-menu";
import { CompanyMark } from "./company-mark";
import { LIFT_SHIFT_PX, LIFT_TILT_DEG, liftTransition, settleTransition } from "./motion";
import { OverdueMeter } from "./overdue-meter";
import { SalaryChip } from "./salary-chip";
import type { BoardCard, CardDate } from "./types";

interface CardViewProps {
  card: BoardCard;
  /** `notify.yaml: push_min_score`, the triangle on the score meter. */
  pushLine: number;
  density: BoardDensity;
  onOpen?: (jobId: number) => void;
  /** The drag handle and the "move to…" menu, top right of the card. */
  controls?: ReactNode;
  /** The copy that follows the pointer while dragging: no controls, tilted, `shadow-e5`. */
  overlay?: boolean;
  className?: string;
}

/** What a pipeline card shows (design "申请看板"): mark, title, company, score, salary, overdue bar, next step, rounds. The controls (drag handle, move menu) are small icon buttons in the corner, so the card keeps the design's height. */
export function CardView({ card, pushLine, density, onOpen, controls, overlay = false, className }: CardViewProps) {
  const t = useTranslations("pipeline");
  const { job } = card;
  const ended = isEndedStatus(card.status);
  const rank = job.rank?.rankValue ?? null;
  const hasNext = card.nextAction !== null;
  const nextText = card.nextAction ?? (ended ? null : t(`nextDefault.${card.status as Exclude<ApplicationStatus, "rejected" | "withdrawn" | "archived">}`));

  const compact = density === "compact";
  const chips = card.interviewRounds > 0 || job.jobStatus !== "active" ? (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {card.interviewRounds > 0 ? <span className="bg-soft text-ink border-ink text-data-sm rounded-cell inline-flex h-5 items-center border px-1.5 font-mono leading-none font-bold whitespace-nowrap" data-testid="card-rounds">{t("card.rounds", { count: card.interviewRounds })}</span> : null}
      {job.jobStatus !== "active" ? <JobStatusChip status={job.jobStatus} /> : null}
    </div>
  ) : null;
  const dateValue = (value: CardDate | "none", applied: boolean) => {
    const fullKey = applied ? "card.appliedFull" : "card.sinceFull";
    if (value === "none") return t("card.appliedNone");
    if ("pending" in value) return t("card.datePending");
    const full = t(fullKey, { date: value.full });
    return <time dateTime={value.iso} title={full}>
      <span aria-hidden>{t(applied ? "card.applied" : "card.since", { date: value.label })}</span>
      <span className="sr-only">{value.full}</span>
    </time>;
  };

  return (
    <article
      data-slot="pipeline-card"
      data-density={density}
      data-job-id={card.jobId}
      data-status={card.status}
      data-overdue={card.overdue ? card.overdue.kind : undefined}
      aria-label={`${job.companyName} · ${job.title}`}
      className={cn("bg-card text-card-foreground border-bw border-ink rounded-card shadow-e2 @container flex flex-col p-sp-2", compact ? "gap-sp-1" : "gap-sp-2", overlay && "shadow-e5 cursor-grabbing", className)}
    >
      {/* title first, with the controls in its corner; the company gets a full line of its own under it (design: mark + title + company, then the score row) */}
      <div className="gap-sp-1 flex items-start justify-between">
        {job.favorite ? <FavoriteMark className="mt-1" /> : null}
        {overlay ? (
          <div title={job.title} className={cn("text-title-sm min-w-0 flex-1 font-extrabold [overflow-wrap:anywhere]", compact && "line-clamp-[var(--card-title-lines)]")}>{job.title}</div>
        ) : (
          <button type="button" title={job.title} className={cn("text-title-sm rounded-tag min-w-0 flex-1 text-left font-extrabold [overflow-wrap:anywhere] hover:underline focus-visible:underline", compact && "line-clamp-[var(--card-title-lines)]")} data-testid="card-open" onClick={() => onOpen?.(card.jobId)}>
            {job.title}
          </button>
        )}
        {controls ? <div className="-mt-1 -mr-1 flex shrink-0 items-center">{controls}</div> : null}
      </div>
      <div className="gap-sp-2 flex items-center">
        <CompanyMark name={job.companyName} className={compact ? "size-5" : "size-6"} />
        <div className="text-ink-2 text-body-sm min-w-0 flex-1 truncate" title={job.companyName}>
          {job.companyName}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-sp-2 gap-y-1">
        <ScoreMeter value={rank} pushLine={pushLine} size="sm" className="items-center gap-x-1.5 [--num-m:var(--num-s)] [&_.jr-score\_\_b]:sr-only [&_.jr-score\_\_d]:hidden" />
        <SalaryChip salary={card.salary} floor={job.amountMinAnnualEur} />
      </div>

      {card.clock ? <OverdueMeter clock={card.clock} overdue={card.overdue !== null} /> : null}

      <div className="flex flex-wrap items-center gap-x-sp-2 gap-y-sp-1">
        <dl data-testid="card-dates" className="text-data-sm text-ink-2 flex flex-wrap items-center gap-x-sp-2 gap-y-sp-1 font-mono">
          {card.appliedDate !== null ? <div className="min-w-0" data-testid="card-applied-date">
            <dt className="sr-only">{t("card.appliedTerm")}</dt>
            <dd>{dateValue(card.appliedDate, true)}</dd>
          </div> : null}
          <div className="min-w-0" data-testid="card-status-date">
            <dt className="sr-only">{t("card.sinceTerm")}</dt>
            <dd>{dateValue(card.statusDate, false)}</dd>
          </div>
        </dl>
        {compact ? chips : null}
      </div>

      {ended ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusChip status={card.status} />
        </div>
      ) : (
        <div className="border-grid text-data-sm text-ink-2 border-t-bw border-dashed pt-1 font-mono" data-slot="card-next">
          <span className="sr-only">{t("card.next")}: </span>
          <span aria-hidden>{t("card.next")} → </span>
          <b title={nextText ?? undefined} className={cn("text-ink font-bold [overflow-wrap:anywhere]", compact && "line-clamp-[var(--card-next-lines)]", !hasNext && "text-ink-3 font-medium")}>{nextText}</b>
          {card.nextActionDateLabel ? (
            <span className="tabular-nums" data-testid="card-next-date">
              {" "}
              · {card.nextActionDateLabel}
            </span>
          ) : null}
        </div>
      )}

      {!compact ? chips : null}

    </article>
  );
}

/** The card under the pointer while dragging: it tilts 3 degrees and steps up-left as its shadow grows (reduced motion: neither). */
export function LiftedCard({ card, pushLine, density }: { card: BoardCard; pushLine: number; density: BoardDensity }) {
  const reduced = useReducedMotion();
  return (
    <motion.div initial={false} animate={reduced ? { rotate: 0, x: 0, y: 0 } : { rotate: LIFT_TILT_DEG, x: LIFT_SHIFT_PX, y: LIFT_SHIFT_PX }} transition={liftTransition(reduced)} data-testid="card-lifted">
      <CardView density={density} card={card} pushLine={pushLine} overlay />
    </motion.div>
  );
}

interface DraggableCardProps {
  card: BoardCard;
  pushLine: number;
  density: BoardDensity;
  /** The card has just been dropped here: it lands with a tilt that springs back to level. */
  settling?: boolean;
  onOpen: (jobId: number) => void;
  onMove: (jobId: number, status: ApplicationStatus) => void;
}

/**
 * A card that can be dragged to another column. With the mouse the whole card is the handle (after a few pixels of travel,
 * so a click stays a click). With the keyboard the grip button is: Tab to it, Space or Enter picks the card up, the arrow keys
 * walk through the columns, Space or Enter drops, Esc cancels, and the live region announces each step. Only the grip button
 * is the keyboard activator, so Enter and Space on the title and the menu button keep working as buttons. Touch screens and
 * anyone who prefers a menu use "move to…" on the card. While dragging, dnd-kit moves the overlay copy and this card stays
 * put, faded; after the drop Motion flies it from its old place to the new one (layout animation) and levels the tilt.
 */
export function DraggableCard({ card, pushLine, density, settling = false, onOpen, onMove }: DraggableCardProps) {
  const t = useTranslations("pipeline");
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, isDragging } = useDraggable({ id: card.jobId });
  const reduced = useReducedMotion();
  const company = card.job.companyName;
  const controls = (
    <div className="flex items-center">
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        aria-label={t("card.dragFor", { company })}
        data-testid="card-handle"
        className="text-ink-3 hover:text-ink rounded-tag inline-grid size-11 shrink-0 md:size-7 place-items-center"
      >
        <GripVertical aria-hidden className="size-4" />
      </button>
      <div onMouseDown={(event) => event.stopPropagation()}>
        <CardMoveMenu jobId={card.jobId} company={company} status={card.status} onMove={onMove} />
      </div>
    </div>
  );
  return (
    <div ref={setNodeRef} {...listeners} data-testid="pipeline-card" className={cn("md:cursor-grab md:select-none", isDragging && "opacity-40")}>
      <motion.div
        layout="position"
        layoutId={`pipeline-card-${card.jobId}`}
        initial={settling && !reduced ? { rotate: LIFT_TILT_DEG } : false}
        animate={{ rotate: 0 }}
        transition={settleTransition(reduced)}
      >
        <CardView density={density} card={card} pushLine={pushLine} onOpen={onOpen} controls={controls} />
      </motion.div>
    </div>
  );
}

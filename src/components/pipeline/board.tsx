"use client";

import { DndContext, DragOverlay, MouseSensor, useSensor, useSensors, type Announcements, type CollisionDetection, type DragEndEvent, type DragStartEvent, type UniqueIdentifier } from "@dnd-kit/core";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { parseAsBoolean, parseAsString, useQueryState } from "nuqs";
import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";

import { setApplicationStatusAction as rawSetApplicationStatusAction } from "@/app/jobs/[id]/actions";
import { undoApplicationStatusAction as rawUndoApplicationStatusAction } from "@/app/pipeline/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LayoutGroup, motion } from "@/components/viz";
import { toastTone, toastUndo } from "@/lib/toast";
import type { BoardColumn } from "@/lib/dashboard/board";
import { useHiddenStatuses } from "@/components/applications/visibility-context";
import { ALL_APPLICATION_STATUSES, boardLayout } from "@/lib/applications/visibility";
import { columnOfStatus, countInPipeline, freshClockOf, type OverdueThresholds } from "@/lib/dashboard/board";
import type { ApplicationStatus } from "@/lib/db/repos/applications";
import { cn } from "@/lib/utils";

import { boardCollisions, revealInBoard, zoneCoordinates } from "./board-scroll";
import { CardDrawer } from "./card-drawer";
import { StatusColumn } from "./board-column";
import { LiftedCard } from "./card";
import { EagerKeyboardSensor } from "./keyboard-sensor";
import { EndedColumn } from "./ended-column";
import { HiddenColumn } from "./hidden-column";
import type { BoardCard } from "./types";
import { withActionFeedback } from "@/lib/actions/client";

const setApplicationStatusAction = withActionFeedback(rawSetApplicationStatusAction)(() => ({ ok: false, error: "failed" }));
const undoApplicationStatusAction = withActionFeedback(rawUndoApplicationStatusAction)(() => ({ ok: false, error: "failed" }));

/** Pixels the pointer must travel before a press on a card becomes a drag (a click on the title or menu stays a click). */
const DRAG_DISTANCE_PX = 8;

function isStatus(value: unknown): value is ApplicationStatus {
  return ALL_APPLICATION_STATUSES.some((status) => status === value);
}

function countByStatus(cards: readonly BoardCard[]): Partial<Record<ApplicationStatus, number>> {
  const counts: Partial<Record<ApplicationStatus, number>> = {};
  for (const card of cards) counts[card.status] = (counts[card.status] ?? 0) + 1;
  return counts;
}

function matches(card: BoardCard, needle: string): boolean {
  const haystack = [card.job.companyName, card.job.title, ...card.job.locations, card.nextAction ?? ""].join(" ").toLowerCase();
  return haystack.includes(needle);
}

interface BoardProps {
  cards: readonly BoardCard[];
  /** `notify.yaml: push_min_score`: the triangle on every card's score meter. */
  pushLine: number;
  /** notify.yaml `reminders`: a card moved into interested / applied starts a fresh clock against these. */
  thresholds: OverdueThresholds;
}

/**
 * The application board. Drag a card to another column with the mouse, or use the status menu
 * on the card (the only way on touch screens and with the keyboard). Both go through
 * `setApplicationStatusAction`, which writes the application event; the toast that follows has an Undo that
 * sets the previous status through the same action. Filters live in the URL
 * (`?q=`, `?overdue=true`) and apply on the client: the whole board is a few dozen cards.
 */
export function Board({ cards, pushLine, thresholds }: BoardProps) {
  const t = useTranslations("pipeline");
  const ts = useTranslations("dashboard.status");
  const [saving, startTransition] = useTransition();
  // the card moves at once; when the action is done the server's cards replace this state
  const [shown, applyMove] = useOptimistic(cards, (state, move: { jobId: number; status: ApplicationStatus }) =>
    state.map((card) => (card.jobId !== move.jobId ? card : { ...card, status: move.status, overdue: null, clock: freshClockOf(move.status, thresholds) })),
  );
  const [query, setQuery] = useQueryState("q", parseAsString.withDefault(""));
  const [overdueOnly, setOverdueOnly] = useQueryState("overdue", parseAsBoolean.withDefault(false));
  const [openId, setOpenId] = useState<number | null>(null);
  const [endedOpen, setEndedOpen] = useState(false);
  // Which hidden-but-not-empty columns are unfolded
  const [openHidden, setOpenHidden] = useState<ReadonlySet<string>>(new Set());
  const hidden = useHiddenStatuses();
  const [dragId, setDragId] = useState<number | null>(null);
  // the card that was just moved: it lands in its new column with a tilt that springs level
  const [settleId, setSettleId] = useState<number | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const keyboardTarget = useRef<UniqueIdentifier | null>(null);
  const landing = useRef<number | null>(null);
  const [navigation, setNavigation] = useState({ prev: false, next: false });
  // the card that was dropped with the keyboard: its drag handle takes the focus back once the card has landed in its new column
  const focusHandleOf = useRef<number | null>(null);
  const lastOpened = useRef<number | null>(null);
  const collisionDetection: CollisionDetection = (args) => boardCollisions(args, boardRef.current, keyboardTarget.current);
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: DRAG_DISTANCE_PX } }), useSensor(EagerKeyboardSensor, { coordinateGetter: (event, args) => zoneCoordinates(boardRef.current, keyboardTarget)(event, args), scrollBehavior: "instant" }));

  /** Save a status change; a successful one says so in a toast whose Undo restores `previous` the same way. */
  const commit = (target: { jobId: number; company: string }, status: ApplicationStatus, previous: ApplicationStatus, isUndo: boolean) => {
    if (columnOfStatus(status) === "ended") setEndedOpen(true);
    landing.current = target.jobId;
    startTransition(async () => {
      applyMove({ jobId: target.jobId, status });
      setSettleId(target.jobId);
      if (isUndo) {
        // an undo takes the move back (its event and clock) instead of writing a second event
        const undone = await undoApplicationStatusAction({ jobId: target.jobId, movedTo: previous, restoreTo: status });
        if (undone.ok) toastTone("success", t("undone", { company: target.company, status: ts(status === "new" ? "newFull" : status) }));
        else toastTone("error", t(`error.${undone.error}`));
        return;
      }
      const result = await setApplicationStatusAction({ jobId: target.jobId, status });
      if (!result.ok) {
        toastTone("error", t(`error.${result.error}`));
        return;
      }
      // nothing was written (the card already had this status): nothing to confirm, and nothing to undo
      if (!result.changed) return;
      const restore = result.previous ?? previous;
      toastUndo(t("moved", { company: target.company, status: ts(status === "new" ? "newFull" : status) }), () => commit(target, restore, status, true));
    });
  };

  const move = (jobId: number, status: ApplicationStatus) => {
    // compare with what the board shows (a move that is still being saved counts)
    const card = shown.find((c) => c.jobId === jobId);
    if (!card || card.status === status) return;
    commit({ jobId, company: card.job.companyName }, status, card.status, false);
  };

  const needle = query.trim().toLowerCase();
  const filtering = needle !== "" || overdueOnly;
  const visible = shown.filter((card) => (!overdueOnly || card.overdue !== null) && (needle === "" || matches(card, needle)));
  const byColumn = (column: BoardColumn) => visible.filter((card) => columnOfStatus(card.status) === column);
  // the share bars are shares of the cards in the flow; the ended jobs are counted in their own column
  const total = countInPipeline(visible);
  const endedCards = byColumn("ended");
  // the layout is drawn from all cards, not the filtered ones: a column does not vanish because a search hides its cards
  const layout = boardLayout(hidden, countByStatus(shown));
  const dragged = dragId === null ? null : (shown.find((card) => card.jobId === dragId) ?? null);
  const open = openId === null ? null : (shown.find((card) => card.jobId === openId) ?? null);
  const openCard = (jobId: number) => {
    lastOpened.current = jobId;
    setOpenId(jobId);
  };
  const cardElement = (jobId: number | null, selector: string): HTMLElement | null => (jobId === null ? null : (boardRef.current?.querySelector<HTMLElement>(`[data-job-id="${jobId}"] ${selector}`) ?? null));

  // Wait for the saved card (or the restored card on failure), then reveal it before returning focus.
  useEffect(() => {
    const board = boardRef.current;
    if (!board || saving || dragId !== null) return;
    const jobId = landing.current ?? focusHandleOf.current;
    if (jobId === null) return;
    const reveal = () => {
      const handle = cardElement(jobId, '[data-testid="card-handle"]');
      const card = handle?.closest<HTMLElement>('[data-testid="pipeline-card"]');
      if (!card || !handle) return false;
      revealInBoard(card, board);
      if (focusHandleOf.current === jobId) {
        handle.focus({ preventScroll: true });
        focusHandleOf.current = null;
      }
      landing.current = null;
      return true;
    };
    // A frame lets the new column finish layout. A filtered/unmounted card can arrive on the next server render.
    const observer = new MutationObserver(() => { if (reveal()) observer.disconnect(); });
    const frame = requestAnimationFrame(() => {
      if (!reveal()) observer.observe(board, { childList: true, subtree: true });
    });
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  });

  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const update = () => setNavigation({ prev: board.scrollLeft > 1, next: board.scrollLeft + board.clientWidth < board.scrollWidth - 1 });
    update();
    board.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(board);
    for (const column of board.children) observer.observe(column);
    return () => { board.removeEventListener("scroll", update); observer.disconnect(); };
  }, [cards.length, hidden, openHidden]);

  const scrollColumn = (direction: -1 | 1) => {
    const board = boardRef.current;
    const column = board?.querySelector<HTMLElement>('[data-testid="board-column"]');
    if (!board || !column) return;
    const gap = Number.parseFloat(getComputedStyle(board).columnGap) || 0;
    board.scrollTo({ left: board.scrollLeft + direction * (column.getBoundingClientRect().width + gap), behavior: "instant" });
  };

  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      const card = shown.find((c) => c.jobId === Number(active.id));
      return card ? t("dnd.pickedUp", { company: card.job.companyName, status: ts(card.status) }) : undefined;
    },
    onDragOver: ({ active, over }) => {
      const card = shown.find((c) => c.jobId === Number(active.id));
      if (!card) return undefined;
      return isStatus(over?.id) ? t("dnd.over", { company: card.job.companyName, status: ts(over.id) }) : t("dnd.overNone", { company: card.job.companyName });
    },
    onDragEnd: ({ active, over }) => {
      const card = shown.find((c) => c.jobId === Number(active.id));
      if (!card) return undefined;
      return isStatus(over?.id) ? t("dnd.dropped", { company: card.job.companyName, status: ts(over.id) }) : t("dnd.droppedNone", { company: card.job.companyName });
    },
    onDragCancel: ({ active }) => {
      const card = shown.find((c) => c.jobId === Number(active.id));
      return card ? t("dnd.cancelled", { company: card.job.companyName, status: ts(card.status) }) : undefined;
    },
  };

  // On a phone the first screen would be the empty "New" column: start at the first column that has cards (on wider screens the board starts at its left edge).
  const hasCards = cards.length > 0;
  useEffect(() => {
    const board = boardRef.current;
    if (!board || !hasCards || board.scrollWidth <= board.clientWidth || window.matchMedia("(min-width: 768px)").matches) return;
    const first = Array.from(board.querySelectorAll<HTMLElement>('[data-testid="board-column"]')).find((column) => column.querySelector('[data-testid="pipeline-card"]'));
    if (first) board.scrollLeft = first.offsetLeft - board.offsetLeft;
  }, [hasCards]);

  const onDragStart = (event: DragStartEvent) => {
    keyboardTarget.current = null;
    landing.current = null;
    // Pick-up selects the source zone, preserving the initial announcement and the first arrow's reading order.
    if (event.activatorEvent instanceof KeyboardEvent) keyboardTarget.current = shown.find((card) => card.jobId === Number(event.active.id))?.status ?? null;
    setSettleId(null);
    setDragId(Number(event.active.id));
  };
  const onDragEnd = (event: DragEndEvent) => {
    keyboardTarget.current = null;
    setDragId(null);
    const target = event.over?.id;
    if (event.activatorEvent instanceof KeyboardEvent) focusHandleOf.current = Number(event.active.id);
    if (isStatus(target)) move(Number(event.active.id), target);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-sp-4">
      <div role="search" aria-label={t("filters.label")} className="flex shrink-0 flex-wrap items-center gap-sp-2">
        <div className="relative w-full min-w-0 sm:w-72">
          <Search aria-hidden className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input type="search" value={query} onChange={(event) => void setQuery(event.target.value)} placeholder={t("filters.searchPlaceholder")} aria-label={t("filters.search")} className="pl-8" data-testid="pipeline-search" />
        </div>
        <button
          type="button"
          aria-pressed={overdueOnly}
          onClick={() => void setOverdueOnly(overdueOnly ? null : true)}
          data-testid="overdue-toggle"
          className={cn(
            "text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-7 items-center rounded-full border px-2.5 text-[13px] transition-colors",
            overdueOnly && "border-primary/50 bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground",
          )}
        >
          {t("filters.overdueOnly")}
        </button>
        {filtering ? (
          <button
            type="button"
            onClick={() => {
              void setQuery(null);
              void setOverdueOnly(null);
            }}
            data-testid="pipeline-filter-clear"
            className="text-muted-foreground hover:text-foreground inline-flex h-7 items-center gap-1 rounded-full px-2 text-[13px]"
          >
            <X aria-hidden className="size-3.5" />
            {t("filters.clear")}
          </button>
        ) : null}
        <span className="text-muted-foreground ml-auto text-[13px]" role="status" data-testid="pipeline-count">
          {filtering ? t("filters.shown", { shown: visible.length, count: cards.length }) : ""}
        </span>
        <div className="hidden items-center gap-sp-2 md:flex">
          <Button variant="ghost" size="icon" aria-label={t("nav.prev")} title={t("nav.prev")} data-testid="board-prev" disabled={!navigation.prev} onClick={() => scrollColumn(-1)}><ChevronLeft aria-hidden /></Button>
          <Button variant="ghost" size="icon" aria-label={t("nav.next")} title={t("nav.next")} data-testid="board-next" disabled={!navigation.next} onClick={() => scrollColumn(1)}><ChevronRight aria-hidden /></Button>
        </div>
      </div>

      {cards.length === 0 ? (
        <div className="text-muted-foreground border-border rounded-lg border border-dashed px-4 py-10 text-center text-sm" data-testid="pipeline-empty">
          {t("empty")}{" "}
          <Link href="/jobs" className="text-foreground underline underline-offset-4">
            {t("emptyLink")}
          </Link>
        </div>
      ) : (
        <DndContext id="pipeline-board-dnd" sensors={sensors} accessibility={{ announcements, screenReaderInstructions: { draggable: t("dnd.instructions") } }} collisionDetection={collisionDetection} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => { keyboardTarget.current = null; setDragId(null); }}>
          <motion.div layoutScroll ref={boardRef} role="region" aria-label={t("boardLabel")} tabIndex={0} data-testid="board" data-dragging={dragId !== null ? "true" : undefined} className="relative flex min-h-[var(--board-min-h)] flex-1 snap-x snap-proximity items-stretch gap-sp-3 overflow-x-auto overscroll-x-contain rounded-lg pb-sp-3 data-[dragging=true]:snap-none">
            <LayoutGroup id="pipeline-board">
              {layout.columns.map(({ column, mode }) => {
                if (mode === "none") return null;
                if (column === "ended") {
                  return (
                    <EndedColumn key={column} cards={endedCards} dragging={dragId !== null} open={endedOpen} pushLine={pushLine} settleId={settleId} zones={layout.endedZones} hiddenWithCards={layout.endedHiddenWithCards} onToggle={() => setEndedOpen((value) => !value)} onOpen={openCard} onMove={move} />
                  );
                }
                if (mode === "collapsed") {
                  return (
                    <HiddenColumn
                      key={column}
                      status={column}
                      cards={byColumn(column)}
                      open={openHidden.has(column)}
                      pushLine={pushLine}
                      settleId={settleId}
                      onToggle={() =>
                        setOpenHidden((current) => {
                          const next = new Set(current);
                          if (!next.delete(column)) next.add(column);
                          return next;
                        })
                      }
                      onOpen={openCard}
                      onMove={move}
                    />
                  );
                }
                return <StatusColumn key={column} status={column} cards={byColumn(column)} total={total} pushLine={pushLine} settleId={settleId} onOpen={openCard} onMove={move} />;
              })}
            </LayoutGroup>
          </motion.div>
          <DragOverlay dropAnimation={null}>{dragged ? <LiftedCard card={dragged} pushLine={pushLine} /> : null}</DragOverlay>
        </DndContext>
      )}

      <CardDrawer card={open} onClose={() => setOpenId(null)} onMove={move} returnFocus={() => cardElement(lastOpened.current, '[data-testid="card-open"]')} />
    </div>
  );
}

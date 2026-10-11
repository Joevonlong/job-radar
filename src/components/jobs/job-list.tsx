"use client";

import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";

import { setApplicationStatusAction } from "@/app/jobs/[id]/actions";
import { closeJobAction, reopenJobAction, undoClosureAction } from "@/app/jobs/closure-actions";
import { undoApplicationStatusAction } from "@/app/pipeline/actions";
import { useFavoriteToggle } from "@/components/favorites/use-favorite-toggle";
import { useHiddenStatuses } from "@/components/applications/visibility-context";
import { isStatusOffered } from "@/lib/applications/visibility";
import { LayoutGroup, motion, Presence, useIsPresent, useReducedMotion, VizMotionConfig } from "@/components/viz/motion";
import { ESTIMATED_ROW_HEIGHT, VIRTUALIZE_ROWS_ABOVE } from "@/lib/dashboard/constants";
import { rememberOpenedRow, takeReturnedRow } from "@/lib/dashboard/row-return";
import { effectiveStatus, statusAfterIgnoreKey, statusAfterInterestKey } from "@/lib/dashboard/status";
import type { ApplicationStatus } from "@/lib/db/repos/applications";
import { DEFAULT_SORT_DIR, type JobSort, type SortDir } from "@/lib/jobs/constants";
import { columnOfSort, flipDir, SORTABLE_COLUMNS, type SortableColumn } from "@/lib/jobs/sort";
import { toastTone, toastUndo } from "@/lib/toast";

import { JobRow, type JobListViz, type RowAction } from "./job-row";
import { ROW_ENTER, ROW_EXIT, ROW_TRANSITION } from "./row-motion";
import type { JobListItem } from "./types";
import { useSeenState } from "./use-seen";

import "./jobs.css";

export type { JobListViz } from "./job-row";

/** Only this many rows slide in when the list first appears; the rest are there at once (a long list must not wait for its animation). */
const STAGGER_ROWS = 8;
/** From this many rows on the browser skips laying out and painting rows far from the viewport (`content-visibility`). */
const DENSE_ROWS = 30;
/** How long the toast needs to leave the page (its exit animation) before the focus is put back on a restored row. */
const TOAST_EXIT_SETTLE_MS = 600;
const COLUMNS = ["job", "score", "salary", "signals", "skills", "fresh", "status"] as const;

/** A row of the list: inside a list item that is not playing its exit (a leaving row keeps its old index and job id until it is gone). */
const inList = (selector: string) => `:scope > li:not([data-leaving]) ${selector}`;

/**
 * One list item of the animated (not virtualized) list. While it plays its exit animation it is still in the DOM, but it
 * is no longer part of the list: marked `data-leaving`, hidden from assistive technology and inert (no focus, no clicks).
 * Without this the list would briefly hold the old rows next to the new ones (e.g. 7 rows under a view tab that says 5)
 * for as long as the exit animation takes, which on a busy machine is not bounded.
 */
function ListItem({ reduced, children }: { reduced: boolean; children: React.ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.li
      {...(reduced ? { initial: false } : { layout: "position" as const, initial: ROW_ENTER, exit: ROW_EXIT })}
      animate={{ opacity: 1, x: 0 }}
      transition={reduced ? { duration: 0 } : ROW_TRANSITION}
      className="jb-li"
      {...(present ? {} : { "data-leaving": "true", "aria-hidden": true, inert: true })}
    >
      {children}
    </motion.li>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // (a multi-select's popover and unfolded list are typing targets too: j / k there must not move the rows behind them)
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable || target.closest('[data-slot="multi-select"]') !== null;
}

interface JobListProps {
  jobs: readonly JobListItem[];
  /** Shown when `jobs` is empty. */
  empty: React.ReactNode;
  /** Accessible name of the list. */
  label: string;
  /** Scales and lines of the graphics, loaded from the config files by the page. */
  viz: JobListViz;
  /** "favorites": the favorites page: un-starring takes the row out of the list, with the undo bringing it back. */
  mode?: "default" | "favorites";
  /**
   * The list sorts from its column heads (/jobs only): the current sort, its effective direction, and the link each sortable
   * head goes to (worked out on the server, `nextSortParams` + `jobsListHref`). Absent: the heads are plain text (Today, favorites).
   */
  sortHead?: SortHead;
  /**
   * The "new since your last visit" divider, drawn under the row of `afterJobId` (the last new row of this page when the list is
   * sorted by first seen, newest first). Absent: no divider (other sorts say it next to the count instead).
   */
  newDivider?: { afterJobId: number; count: number };
}

export interface SortHead {
  sort: JobSort;
  dir: SortDir;
  hrefs: Readonly<Record<SortableColumn, string>>;
}

/** The head of a sortable column: a link (works without JS) with the direction arrow and its whole state in the accessible name. */
function SortHeadLink({ column, label, head }: { column: SortableColumn; label: string; head: SortHead }) {
  const t = useTranslations("dashboard.list.sort");
  const active = SORTABLE_COLUMNS[column] === head.sort;
  // a click on the current column flips it; on another column it starts with that column's default (descending for all three)
  const next: SortDir = active ? flipDir(head.dir) : DEFAULT_SORT_DIR[SORTABLE_COLUMNS[column]];
  const Icon = active ? (head.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <Link
      href={head.hrefs[column]}
      scroll={false}
      className="jb-sort"
      data-testid={`sort-head-${column}`}
      data-sort-active={active ? "true" : "false"}
      data-sort-dir={active ? head.dir : undefined}
      aria-label={active ? t("active", { column: label, dir: t(`dir.${head.dir}`), next: t(`dir.${next}`) }) : t("inactive", { column: label, next: t(`dir.${next}`) })}
    >
      <span>{label}</span>
      <Icon aria-hidden className="jb-sort-icon" />
    </Link>
  );
}

/**
 * The job list shared by Today and /jobs: a table (7 graphic columns under a sticky head) on a wide container, cards on a narrow one
 * and on a phone. Rows are focusable groups with a title link; ★ / 👍 / ✕ slide in on hover or focus. Keys: j / k / Enter / s / x / f / u.
 * Unseen jobs are bold with a dot; acting on a row marks it seen, `u` toggles it.
 * `mode="favorites"` is the favorites page: the same list, but a row leaves it when it is un-starred.
 * When the rows change (sort, filter, ignore) they glide to their new place and leaving rows exit first (Motion); with reduced
 * motion everything switches at once. Window-virtualized above `VIRTUALIZE_ROWS_ABOVE` rows (no layout animation there).
 */
export function JobList({ jobs, empty, label, viz, mode = "default", sortHead, newDivider }: JobListProps) {
  const t = useTranslations("dashboard");
  const th = useTranslations("dashboard.list.head");
  const tSort = useTranslations("dashboard.list.sort");
  const tSorts = useTranslations("dashboard.jobs.filters.sorts");
  const tSeen = useTranslations("dashboard.seen");
  const tc = useTranslations("dashboard.closed");
  const router = useRouter();
  const hiddenStatuses = useHiddenStatuses();
  const [, startTransition] = useTransition();
  const listRef = useRef<HTMLUListElement>(null);
  const [activeRaw, setActiveIndex] = useState(0);
  const pendingFocus = useRef<number | null>(null);
  // after an ignore: the job whose row takes the focus (the ignored row leaves Today, so an index would point at the wrong row)
  const pendingFocusJob = useRef<number | null>(null);
  const [, rerender] = useState(0);
  const busy = useRef(false);
  // the first rows slide in once, when the list is first shown; rows that arrive later (a filter was lifted) do not repeat it
  const [staggerIds] = useState(() => new Set(jobs.slice(0, STAGGER_ROWS).map((job) => job.id)));

  // reduced motion: a filtered-out row is gone at once: no exit slide, no layout glide, so no transformed frames either
  const reduced = useReducedMotion();
  // the star of every job on screen, with the optimistic change on top; on the favorites page an un-starred job leaves at once
  const favoritesMode = mode === "favorites";
  const { isFavorite, toggle: toggleFavorite } = useFavoriteToggle(jobs, {
    onUndone: (jobId) => {
      if (!favoritesMode) return;
      pendingFocusJob.current = jobId;
      rerender((n) => n + 1);
      // the toast takes the focus back to the row it stole it from while it leaves; once it is gone the restored row has it
      window.setTimeout(() => {
        const el = listRef.current?.querySelector<HTMLElement>(inList(`[data-job-id="${jobId}"]`));
        if (el && document.activeElement?.closest("[data-job-id]") !== el) el.focus();
      }, TOAST_EXIT_SETTLE_MS);
    },
  });
  const rows = favoritesMode ? jobs.filter((job) => isFavorite(job)) : jobs;
  const { isSeen, setSeen } = useSeenState(jobs);
  /** D5: a decision taken on a row (★ / 👍 / ✕, closing) means the job was seen. */
  const markActed = useCallback(
    (job: JobListItem) => {
      if (!isSeen(job)) void setSeen(job, true);
    },
    [isSeen, setSeen],
  );
  /** `u`: seen <-> unseen. */
  const toggleSeen = useCallback(
    (job: JobListItem) => {
      void setSeen(job, !isSeen(job)).then((ok) => {
        if (!ok) toastTone("error", tSeen("markFailed"));
      });
    },
    [isSeen, setSeen, tSeen],
  );
  // the list can shrink under the active row (a job was ignored): stay inside it
  const activeIndex = Math.max(0, Math.min(activeRaw, rows.length - 1));
  const virtualized = rows.length > VIRTUALIZE_ROWS_ABOVE;

  // ---- virtualization (window scroll): positions are relative to the list's top in the document
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    if (!virtualized || !listRef.current) return;
    setScrollMargin(listRef.current.getBoundingClientRect().top + window.scrollY);
  }, [virtualized]);
  // The row estimate depends on the viewport, which the server cannot know: it starts as the desktop one (what the server rendered,
  // so the list's height does not mismatch at hydration) and switches in a layout effect on a phone (a 135-row Today list
  // made the mismatch show up as a dev-overlay error at 390px).
  const [phone, setPhone] = useState(false);
  useLayoutEffect(() => {
    // (no matchMedia, e.g. in jsdom: the width at mount decides)
    const query = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 767.98px)") : null;
    const sync = () => setPhone(query ? query.matches : window.innerWidth < 768);
    sync();
    query?.addEventListener("change", sync);
    return () => query?.removeEventListener("change", sync);
  }, []);
  const virtualizer = useWindowVirtualizer({
    count: virtualized ? rows.length : 0,
    estimateSize: () => (phone ? ESTIMATED_ROW_HEIGHT.mobile : ESTIMATED_ROW_HEIGHT.desktop),
    overscan: 8,
    scrollMargin,
    getItemKey: (index) => rows[index]?.id ?? index,
  });

  // a new estimate only applies to rows that were not measured yet: drop the cached sizes when the viewport class changes
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [phone, virtualizer]);

  const focusRow = useCallback(
    (index: number) => {
      const target = Math.max(0, Math.min(rows.length - 1, index));
      setActiveIndex(target);
      if (virtualized) virtualizer.scrollToIndex(target, { align: "auto" });
      // focus now when the row is in the DOM (state may not change, so no re-render would follow);
      // otherwise the effect below does it once the row is rendered
      const el = listRef.current?.querySelector<HTMLElement>(inList(`[data-row-index="${target}"]`));
      if (el) {
        el.focus();
        pendingFocus.current = null;
      } else {
        pendingFocus.current = target;
      }
    },
    [rows.length, virtualized, virtualizer],
  );

  // Focus the row chosen by the keyboard once it is rendered (it may be a virtualized one, or the
  // neighbour of a row that just left the list).
  useEffect(() => {
    const jobId = pendingFocusJob.current;
    if (jobId !== null) {
      const index = rows.findIndex((row) => row.id === jobId);
      if (index < 0) return;
      const el = listRef.current?.querySelector<HTMLElement>(inList(`[data-job-id="${jobId}"]`));
      if (!el) {
        // a virtualized row that is not rendered yet: scroll to it, the effect runs again once it is
        if (virtualized) virtualizer.scrollToIndex(index, { align: "auto" });
        return;
      }
      pendingFocusJob.current = null;
      el.focus(); // the row's onFocus makes it the active one
      return;
    }
    const target = pendingFocus.current;
    if (target === null) return;
    const el = listRef.current?.querySelector<HTMLElement>(inList(`[data-row-index="${target}"]`));
    if (!el) return;
    pendingFocus.current = null;
    el.focus({ preventScroll: false });
  });

  // back from a job: the row that was opened gets the focus again (the scroll goes with it)
  useEffect(() => {
    const jobId = takeReturnedRow();
    if (jobId === null) return;
    const index = rows.findIndex((row) => row.id === jobId);
    if (index < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(inList(`[data-job-id="${jobId}"]`));
    if (el) {
      el.focus(); // the row's onFocus makes it the active one
      return;
    }
    // a virtualized row that is not rendered yet: scroll to it, the focus effect above runs once it is
    pendingFocusJob.current = jobId;
    virtualizer.scrollToIndex(index, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the list is shown
  }, []);

  /** A click or Enter that opens a job (the title link, the row itself): remember which one before the page changes. */
  const rememberOpen = useCallback((target: EventTarget | null) => {
    const row = target instanceof HTMLElement ? target.closest<HTMLElement>("[data-job-id]") : null;
    if (!row || (target instanceof HTMLElement && target.closest("button"))) return;
    const id = Number(row.dataset.jobId);
    if (Number.isFinite(id)) rememberOpenedRow(id);
  }, []);

  const changeStatus = useCallback(
    (job: JobListItem, status: ApplicationStatus, index: number) => {
      if (busy.current) return;
      busy.current = true;
      pendingFocus.current = status === "archived" ? null : index;
      // the neighbour that is still there once this row is gone (the next one, the previous one for the last row)
      const neighbour = rows[index + 1] ?? rows[index - 1];
      startTransition(async () => {
        try {
          const result = await setApplicationStatusAction({ jobId: job.id, status });
          if (!result.ok) {
            pendingFocus.current = null;
            toastTone("error", t(`toast.error.${result.error}`));
            return;
          }
          const previous = result.previous ?? "new";
          markActed(job);
          if (status === "archived" && neighbour) {
            pendingFocusJob.current = neighbour.id;
            rerender((n) => n + 1);
          }
          if (status === "archived") {
            toastUndo(
              t("toast.ignored", { title: job.title }),
              async () => {
                // the restored row gets the focus back; it re-appears once the page has refreshed
                pendingFocusJob.current = job.id;
                // take the ignore back (its event and clock; a row the ignore created is removed again) instead of writing a second event
                await undoApplicationStatusAction({ jobId: job.id, movedTo: "archived", restoreTo: previous === "archived" ? "new" : previous });
                rerender((n) => n + 1);
                // the toast takes the focus back to the row it stole it from while it leaves (its own exit); once it is gone the restored row has it
                window.setTimeout(() => {
                  const el = listRef.current?.querySelector<HTMLElement>(inList(`[data-job-id="${job.id}"]`));
                  if (el && document.activeElement?.closest("[data-job-id]") !== el) el.focus();
                }, TOAST_EXIT_SETTLE_MS);
              },
              { tone: "info", label: t("toast.undo") },
            );
          } else if (status === "interested") {
            // S can be taken back like X: same Undo, same rule (the move and its clock are removed, no second event)
            toastUndo(
              t("toast.interested", { title: job.title }),
              async () => {
                await undoApplicationStatusAction({ jobId: job.id, movedTo: "interested", restoreTo: previous === "interested" ? "new" : previous });
              },
              { tone: "success", label: t("toast.undo") },
            );
          } else {
            toastTone("info", t("toast.statusSet", { title: job.title, status: t(`status.${status === "new" ? "newFull" : status}`) }));
          }
        } finally {
          busy.current = false;
        }
      });
    },
    [markActed, rows, t],
  );

  /**
   * `c` / the fourth row button: mark the job closed (it leaves the list unless closed jobs are shown) or reopen one closed by the
   * user or taken down at the source; for a possibly closed one it confirms the close. Undo puts back the judgement before it.
   */
  const toggleClosed = useCallback(
    (job: JobListItem, index: number) => {
      if (busy.current) return;
      busy.current = true;
      const reopen = job.closedReason === "manual" || job.closedReason === "gone";
      const neighbour = rows[index + 1] ?? rows[index - 1];
      startTransition(async () => {
        try {
          const result = reopen ? await reopenJobAction({ jobId: job.id }) : await closeJobAction({ jobId: job.id });
          if (!result.ok) {
            toastTone("error", tc("failed"));
            return;
          }
          markActed(job);
          if (neighbour) {
            pendingFocusJob.current = neighbour.id;
            rerender((n) => n + 1);
          }
          const previous = result.previous;
          toastUndo(
            reopen ? tc("reopenedToast", { title: job.title }) : tc("closedToast", { title: job.title }),
            async () => {
              pendingFocusJob.current = job.id;
              const undone = await undoClosureAction({ jobId: job.id, previous });
              if (!undone.ok) toastTone("error", tc("failed"));
              router.refresh();
              rerender((n) => n + 1);
            },
            { tone: "info", label: t("toast.undo") },
          );
          router.refresh();
        } finally {
          busy.current = false;
        }
      });
    },
    [markActed, router, rows, t, tc],
  );

  /** `f`, `s` and `x` on a row, from the keys or the ★ / 👍 / ✕ buttons: the same rules. */
  const act = useCallback(
    (job: JobListItem, action: RowAction, index: number) => {
      if (action === "close") {
        toggleClosed(job, index);
        return;
      }
      if (action === "favorite") {
        const next = !isFavorite(job);
        // un-starring on the favorites page: the neighbour that is still there once this row is gone takes the focus
        if (favoritesMode && !next) {
          const neighbour = rows[index + 1] ?? rows[index - 1];
          if (neighbour) {
            pendingFocusJob.current = neighbour.id;
            rerender((n) => n + 1);
          }
        }
        void toggleFavorite(job, next);
        markActed(job);
        return;
      }
      if (action === "interested") {
        // `interested` is hidden in ui.yaml: the key (and the button) do nothing
        if (!isStatusOffered("interested", hiddenStatuses)) return;
        const next = statusAfterInterestKey(job.applicationStatus);
        if (next) changeStatus(job, next, index);
        return;
      }
      const next = statusAfterIgnoreKey(job.applicationStatus);
      if (next) changeStatus(job, next, index);
      else toastTone("warn", t("toast.ignoreBlocked", { title: job.title, status: t(`status.${effectiveStatus(job.applicationStatus) === "new" ? "newFull" : effectiveStatus(job.applicationStatus)}`) }));
    },
    [changeStatus, favoritesMode, hiddenStatuses, isFavorite, markActed, rows, t, toggleClosed, toggleFavorite],
  );

  // the key handler lives in one effect that always sees the newest rows; the memoised rows get stable callbacks
  const actRef = useRef(act);
  useEffect(() => {
    actRef.current = act;
  }, [act]);
  const onAction = useCallback((job: JobListItem, action: RowAction, index: number) => actRef.current(job, action, index), []);
  const onFocusRow = useCallback((index: number) => setActiveIndex(index), []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (isTypingTarget(event.target) || document.querySelector('[role="dialog"]')) return;
      const key = event.key.toLowerCase();
      if (!["j", "k", "s", "x", "f", "u", "c", "enter"].includes(key) || rows.length === 0) return;

      const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-row-index]");
      const focusedIndex = focused ? Number(focused.dataset.rowIndex) : null;

      if (key === "j" || key === "k") {
        event.preventDefault();
        const from = focusedIndex ?? activeIndex;
        focusRow(focusedIndex === null ? from : from + (key === "j" ? 1 : -1));
        return;
      }
      if (focusedIndex === null) return;
      const job = rows[focusedIndex];
      if (!job) return;

      if (key === "enter") {
        // the title link and the buttons inside the row do their own thing natively; Enter on the row itself opens the job
        if (document.activeElement === focused) {
          event.preventDefault();
          rememberOpenedRow(job.id);
          router.push(`/jobs/${job.id}`);
        }
        return;
      }
      event.preventDefault();
      if (key === "u") {
        toggleSeen(job);
        return;
      }
      act(job, key === "s" ? "interested" : key === "f" ? "favorite" : key === "c" ? "close" : "ignore", focusedIndex);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, act, focusRow, router, rows, toggleSeen]);

  if (rows.length === 0) {
    return (
      <div className="border-border bg-card text-muted-foreground shadow-e3 rounded-card border-bw px-sp-4 py-sp-8 text-center" data-testid="job-list-empty">
        {empty}
      </div>
    );
  }

  const renderRow = (index: number) => {
    const job = rows[index];
    if (!job) return null;
    return (
      <>
        <JobRow job={job} favorite={isFavorite(job)} seen={isSeen(job)} mode={mode} index={index} active={index === activeIndex} stagger={staggerIds.has(job.id) && index < STAGGER_ROWS} viz={viz} onFocusRow={onFocusRow} onAction={onAction} />
        {newDivider && newDivider.afterJobId === job.id ? (
          // inside the row's list item (a list holds only items; the virtualizer counts rows)
          <div role="separator" className="jb-divider" data-testid="new-since-divider" aria-label={tSeen("divider", { count: newDivider.count })}>
            <span aria-hidden>{tSeen("divider", { count: newDivider.count })}</span>
          </div>
        ) : null}
      </>
    );
  };

  const head = sortHead ? (
    // A visual head, not table semantics (the list is a list of cards on a narrow screen): a group of links whose names say the state
    <div className="jb-head" role="group" aria-label={tSort("headLabel")} data-slot="list-head" data-sortable="true">
      {COLUMNS.map((column) => {
        const sortable = column === "score" || column === "salary" || column === "fresh";
        return sortable ? (
          <span key={column}>
            <SortHeadLink column={column} label={th(column)} head={sortHead} />
          </span>
        ) : (
          <span key={column} aria-hidden>
            {th(column)}
          </span>
        );
      })}
    </div>
  ) : (
    <div className="jb-head" aria-hidden data-slot="list-head">
      {COLUMNS.map((column) => (
        <span key={column}>{th(column)}</span>
      ))}
    </div>
  );
  // the sort as a sentence for assistive technology (a head click or the drop-down changes it); every width, also where the head is hidden
  const sortColumn = sortHead ? columnOfSort(sortHead.sort) : null;
  const sortStatus = sortHead ? (
    <span className="sr-only" role="status" data-testid="sort-status">
      {tSort("status", { column: sortColumn ? th(sortColumn) : tSorts(sortHead.sort), dir: tSort(`dir.${sortHead.dir}`) })}
    </span>
  ) : null;

  if (!virtualized) {
    return (
      <div className="jb" data-dense={rows.length > DENSE_ROWS ? "true" : "false"}>
        {sortStatus}
        <div className="jb-frame">
          {head}
          <VizMotionConfig>
            <LayoutGroup>
              <ul ref={listRef} aria-label={label} className="m-0 list-none p-0" data-testid="job-list" onClickCapture={(event) => rememberOpen(event.target)}>
                <Presence>
                  {rows.map((job, index) => (
                    <ListItem key={job.id} reduced={reduced}>
                      {renderRow(index)}
                    </ListItem>
                  ))}
                </Presence>
              </ul>
            </LayoutGroup>
          </VizMotionConfig>
        </div>
      </div>
    );
  }

  return (
    <div className="jb" data-dense="true">
      {sortStatus}
      <div className="jb-frame">
        {head}
        <ul ref={listRef} aria-label={label} className="relative m-0 list-none p-0" style={{ height: virtualizer.getTotalSize() }} data-testid="job-list" data-virtualized="true" onClickCapture={(event) => rememberOpen(event.target)}>
          {virtualizer.getVirtualItems().map((item) => (
            <li
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="jb-li absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`, contentVisibility: "visible" }}
            >
              {renderRow(item.index)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}


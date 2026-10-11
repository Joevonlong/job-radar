import type { NotifyConfig } from "@/lib/config/schemas/notify";
import type { ApplicationStatus } from "@/lib/db/repos/applications";
import { isCalendarDate } from "@/lib/jobs/search-params";

/**
 * Pipeline board: which status sits in which column, when a card counts as overdue, and how
 * the "next step" date is stored. Pure, so the server page, the client board and the tests agree.
 */

/** The statuses that share the last column ("ended"), in the order its drop zones are listed. */
export const ENDED_STATUSES = ["rejected", "withdrawn", "archived"] as const satisfies readonly ApplicationStatus[];

/** Board columns left to right. `ended` holds `ENDED_STATUSES`; every other column is exactly one status. */
export const BOARD_COLUMNS = ["new", "interested", "preparing", "applied", "interviewing", "offer", "ended"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export function isEndedStatus(status: ApplicationStatus): boolean {
  return (ENDED_STATUSES as readonly ApplicationStatus[]).includes(status);
}

/**
 * The ONE definition of "in the pipeline": every application that is not ended, `new` included (a `new` application row is a
 * card in the first column). The page title, the column share bars and the sidebar's "Applications" badge all count this set
 * (`isInPipeline` here, `PIPELINE_STATUSES` in the badge's SQL), so the three numbers cannot drift apart.
 */
export const PIPELINE_STATUSES = ["new", "interested", "preparing", "applied", "interviewing", "offer"] as const satisfies readonly ApplicationStatus[];

export function isInPipeline(status: ApplicationStatus): boolean {
  return !isEndedStatus(status);
}

/** How many of the cards are in the pipeline (not ended). */
export function countInPipeline(cards: readonly { status: ApplicationStatus }[]): number {
  return cards.filter((card) => isInPipeline(card.status)).length;
}

export function columnOfStatus(status: ApplicationStatus): BoardColumn {
  return isEndedStatus(status) ? "ended" : (status as Exclude<BoardColumn, "ended">);
}

/** Days after which a card in the status is overdue; from notify.yaml `reminders` (C8). */
export interface OverdueThresholds {
  interestedDays: number;
  appliedDays: number;
}

/** The thresholds the Telegram reminder uses (notify.yaml `reminders`): the board marks the same cards. */
export function overdueThresholds(notify: Pick<NotifyConfig, "reminders">): OverdueThresholds {
  return { interestedDays: notify.reminders.interested_days, appliedDays: notify.reminders.applied_days };
}

export type OverdueKind = "interested" | "applied";

export interface Overdue {
  kind: OverdueKind;
  /** Whole days the card has been in its status. */
  days: number;
}

const DAY_MS = 86_400_000;

/** Which clock a status runs, if any: `interested` (not applied yet) and `applied` (no answer yet). */
export function clockKindOf(status: ApplicationStatus): OverdueKind | null {
  return status === "interested" ? "interested" : status === "applied" ? "applied" : null;
}

function limitDaysOf(kind: OverdueKind, thresholds: OverdueThresholds): number {
  return kind === "interested" ? thresholds.interestedDays : thresholds.appliedDays;
}

/** How long a card has sat in a status that has a reminder threshold, next to that threshold (the bar on the card). */
export interface StageClock {
  kind: OverdueKind;
  /** Whole days in the status. */
  days: number;
  /** notify.yaml `reminders.interested_days` / `applied_days`. */
  limitDays: number;
}

/** The bar on a card ends at this multiple of the threshold; the threshold tick sits at 1 / CLOCK_SCALE of the track. */
export const CLOCK_SCALE = 1.5;

/** Elapsed days and threshold of a card in `interested` / `applied`; null for every other status. */
export function stageClockOf(status: ApplicationStatus, statusChangedAt: Date, now: Date, thresholds: OverdueThresholds): StageClock | null {
  const kind = clockKindOf(status);
  if (kind === null) return null;
  const elapsed = Math.max(0, now.getTime() - statusChangedAt.getTime());
  return { kind, days: Math.floor(elapsed / DAY_MS), limitDays: limitDaysOf(kind, thresholds) };
}

/** The clock of a card that has just entered the status (0 days): what the board shows while a move is being saved. */
export function freshClockOf(status: ApplicationStatus, thresholds: OverdueThresholds): StageClock | null {
  const origin = new Date(0);
  return stageClockOf(status, origin, origin, thresholds);
}

/** Fill and threshold tick of the clock bar, in percent of the track. */
export function clockBar(clock: StageClock): { fill: number; tick: number } {
  const full = clock.limitDays * CLOCK_SCALE;
  return { fill: full <= 0 ? 100 : Math.min(100, (clock.days / full) * 100), tick: 100 / CLOCK_SCALE };
}

/**
 * Overdue marker of a card: "interested" for more than N days without applying, "applied" for more
 * than M days without an answer. Same rule as the Telegram reminder: strictly longer than the threshold.
 */
export function overdueOf(status: ApplicationStatus, statusChangedAt: Date, now: Date, thresholds: OverdueThresholds): Overdue | null {
  const clock = stageClockOf(status, statusChangedAt, now, thresholds);
  if (clock === null) return null;
  const elapsed = now.getTime() - statusChangedAt.getTime();
  if (elapsed <= clock.limitDays * DAY_MS) return null;
  return { kind: clock.kind, days: clock.days };
}

/**
 * The next-step date is a calendar day without a time. It is stored as noon UTC of that day, so the
 * same day comes back in any time zone (`timestampToNextActionDate`).
 */
export function nextActionDateToTimestamp(date: string): Date | null {
  return isCalendarDate(date) ? new Date(`${date}T12:00:00Z`) : null;
}

export function timestampToNextActionDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

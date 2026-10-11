/**
 * Which application statuses and categories the interface shows. Display only: hiding a status never changes
 * what the server accepts, what is stored or what the cards in it do (statuses are fixed, the user may
 * hide the ones they do not use). Pure and free of zod and server-only imports: the browser and the server share it.
 */
import type { ApplicationStatus } from "@/lib/db/repos/applications";

/** Every status, in pipeline order (the order of the `application_status` enum; `tests/applications/visibility.test.ts` compares them). */
export const ALL_APPLICATION_STATUSES = ["new", "interested", "preparing", "applied", "interviewing", "offer", "rejected", "withdrawn", "archived"] as const satisfies readonly ApplicationStatus[];

/** `new` is where every job starts and `archived` ("ignored") is the way a job is dismissed: both are always shown. */
export const HIDEABLE_STATUSES = ["interested", "preparing", "applied", "interviewing", "offer", "rejected", "withdrawn"] as const satisfies readonly ApplicationStatus[];
export type HideableStatus = (typeof HIDEABLE_STATUSES)[number];

/** Workplace and contract values the /jobs filter can hide (`unknown` stays: a posting that says nothing must stay findable). */
export const HIDEABLE_WORKPLACES = ["onsite", "hybrid", "remote"] as const;
export const HIDEABLE_CONTRACTS = ["permanent", "fixed_term", "freelance", "temp_agency", "student"] as const;

/** The board's columns, left to right; `ended` holds `ENDED_STATUSES` (mirrors `lib/dashboard/board.ts`). */
const COLUMN_STATUSES = ["new", "interested", "preparing", "applied", "interviewing", "offer"] as const;
const ENDED = ["rejected", "withdrawn", "archived"] as const;

export function isHideableStatus(status: string): status is HideableStatus {
  return (HIDEABLE_STATUSES as readonly string[]).includes(status);
}

/** True when the status is hidden (`new` / `archived` never are, whatever the list says). */
export function isStatusHidden(status: ApplicationStatus, hidden: readonly string[]): boolean {
  return isHideableStatus(status) && hidden.includes(status);
}

export interface StatusChoice {
  status: ApplicationStatus;
  /** The card's own status while it is hidden: listed so the menu still shows where the card is, labelled "(hidden)". */
  hidden: boolean;
}

/** The statuses a "move to" menu / dropdown lists for a card in `current`: the visible ones, plus its own. */
export function statusChoices(current: ApplicationStatus | null, hidden: readonly string[]): StatusChoice[] {
  const out: StatusChoice[] = [];
  for (const status of ALL_APPLICATION_STATUSES) {
    if (!isStatusHidden(status, hidden)) out.push({ status, hidden: false });
    else if (status === current) out.push({ status, hidden: true });
  }
  return out;
}

/** True when a shortcut / button may move a card to `status` (a hidden target is not offered). */
export function isStatusOffered(status: ApplicationStatus, hidden: readonly string[]): boolean {
  return !isStatusHidden(status, hidden);
}

export type ColumnMode = "shown" | "collapsed" | "none";

export interface BoardLayoutColumn {
  column: (typeof COLUMN_STATUSES)[number] | "ended";
  mode: ColumnMode;
  /** The number of cards the column holds (what the collapsed column says). */
  count: number;
}

export interface BoardLayout {
  columns: BoardLayoutColumn[];
  /** Statuses of the ended column that get a drop zone (the hidden ones are left out). */
  endedZones: (typeof ENDED)[number][];
  /** Hidden statuses of the ended column that still hold cards: listed in the column, but nothing can be dropped on them. */
  endedHiddenWithCards: (typeof ENDED)[number][];
  /** Cards that sit in a hidden status (the page header says so). */
  hiddenCards: number;
}

/**
 * How the board draws each column. A hidden status without cards loses its column; one with cards becomes a collapsed
 * narrow column (open it to see them; nothing can be dropped there). The ended column always stays; its hidden statuses
 * lose their drop zone.
 */
export function boardLayout(hidden: readonly string[], counts: Readonly<Partial<Record<ApplicationStatus, number>>>): BoardLayout {
  const countOf = (status: ApplicationStatus) => counts[status] ?? 0;
  const columns: BoardLayoutColumn[] = COLUMN_STATUSES.map((status) => {
    const count = countOf(status);
    const mode: ColumnMode = !isStatusHidden(status, hidden) ? "shown" : count > 0 ? "collapsed" : "none";
    return { column: status, mode, count };
  });
  const endedCount = ENDED.reduce((sum, status) => sum + countOf(status), 0);
  columns.push({ column: "ended", mode: "shown", count: endedCount });
  const hiddenCards = ALL_APPLICATION_STATUSES.filter((status) => isStatusHidden(status, hidden)).reduce((sum, status) => sum + countOf(status), 0);
  return {
    columns,
    endedZones: ENDED.filter((status) => !isStatusHidden(status, hidden)),
    endedHiddenWithCards: ENDED.filter((status) => isStatusHidden(status, hidden) && countOf(status) > 0),
    hiddenCards,
  };
}

/** The values a /jobs filter lists: everything except the hidden ones, but a value that is selected stays (a link or saved view keeps working). */
export function filterOptions<T extends string>(all: readonly T[], hidden: readonly string[], selected: readonly string[]): T[] {
  return all.filter((value) => !hidden.includes(value) || selected.includes(value));
}

/** The stage of a funnel is drawn unless it is hidden and empty. */
export function isStageDrawn(status: ApplicationStatus, hidden: readonly string[], count: number): boolean {
  return !isStatusHidden(status, hidden) || count > 0;
}

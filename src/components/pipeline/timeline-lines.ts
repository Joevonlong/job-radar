import type { TermLine } from "@/components/viz";
import type { ApplicationStatus } from "@/lib/db/repos/applications";

import type { BoardEvent } from "./types";

/** What happened in one application event. The table only has status events today; the fallback keeps a new kind from rendering blank. */
export type EventKind = "created" | "moved" | "stayed" | "unknown";

export function eventKindOf(event: Pick<BoardEvent, "from" | "to">): EventKind {
  if (!event.to) return "unknown";
  if (event.from === null) return "created";
  return event.from === event.to ? "stayed" : "moved";
}

/** Words of the lines (from the messages); `status` turns a status into its name. */
export interface TimelineLabels {
  status: (status: ApplicationStatus) => string;
  created: (to: string) => string;
  moved: (from: string, to: string) => string;
  stayed: (to: string) => string;
  note: (text: string) => string;
  /** Unknown kind: says so with the raw kind. */
  generic: (kind: string) => string;
}

/**
 * The lines of the drawer's terminal log, oldest first (a log reads top to bottom), the newest amber. Every event is one
 * line that says what happened, followed by a dim line for its note; no line is ever blank.
 */
export function timelineLines(eventsNewestFirst: readonly BoardEvent[], labels: TimelineLabels): TermLine[] {
  const chronological = [...eventsNewestFirst].reverse();
  return chronological.flatMap((event, position): TermLine[] => {
    const kind = eventKindOf(event);
    const to = event.to ? labels.status(event.to) : "";
    const from = event.from ? labels.status(event.from) : "";
    const text =
      kind === "created" ? labels.created(to) : kind === "moved" ? labels.moved(from, to) : kind === "stayed" ? labels.stayed(to) : labels.generic(kind);
    const main: TermLine = { prefix: event.when, text: text.trim() === "" ? labels.generic(kind) : text, tone: position === chronological.length - 1 ? "amber" : "ink" };
    const note = event.note?.trim();
    return note ? [main, { text: labels.note(note), tone: "dim" }] : [main];
  });
}

import { getFormatter } from "next-intl/server";

import { toListItems } from "@/components/jobs/to-list-items";
import { firstAppliedAt, showsAppliedDate, overdueOf, stageClockOf, timestampToNextActionDate, type OverdueThresholds } from "@/lib/dashboard/board";
import type { PipelineEntry } from "@/lib/db/queries/pipeline";
import { formatEventDate } from "@/lib/format/time";

import { boardSalaryOf } from "./salary";
import type { BoardCard, CardDate } from "./types";

/**
 * Turn query entries into the serializable cards the board renders. Done on the server so times
 * are formatted once (in the schedule's time zone) and match between server HTML and hydration.
 */
export async function toBoardCards(
  entries: readonly PipelineEntry[],
  options: { now: Date; timezone: string; thresholds: OverdueThresholds; visa?: boolean },
): Promise<BoardCard[]> {
  const { now, timezone, thresholds } = options;
  const [items, format] = await Promise.all([toListItems(entries.map((e) => e.job), { now, timezone, ...(options.visa === undefined ? {} : { visa: options.visa }) }), getFormatter()]);

  const cardDate = (date: Date): CardDate => ({
    iso: date.toISOString(),
    label: formatEventDate(format, date, now, timezone),
    full: format.dateTime(date, { dateStyle: "medium", timeStyle: "short", timeZone: timezone }),
  });
  return entries.map((entry, index) => {
    const { application } = entry;
    const item = items[index];
    if (!item) throw new Error("toBoardCards: list item missing");
    const appliedAt = firstAppliedAt(entry.events);
    return {
      appliedDate: appliedAt ? cardDate(appliedAt) : showsAppliedDate(application.status, appliedAt) ? "none" : null,
      statusDate: cardDate(application.statusChangedAt),
      jobId: application.jobId,
      job: item,
      status: application.status,
      salary: boardSalaryOf(entry.job.salary),
      overdue: overdueOf(application.status, application.statusChangedAt, now, thresholds),
      clock: stageClockOf(application.status, application.statusChangedAt, now, thresholds),
      nextAction: application.nextAction,
      nextActionDate: application.nextActionAt ? timestampToNextActionDate(application.nextActionAt) : null,
      // the stored value is noon UTC of the chosen day: format it in UTC to read the same day back
      nextActionDateLabel: application.nextActionAt ? format.dateTime(application.nextActionAt, { month: "short", day: "numeric", timeZone: "UTC" }) : null,
      notes: application.notesMd ?? "",
      interviewRounds: application.interviewRounds,
      events: entry.events.map((event) => ({
        id: event.id,
        when: format.dateTime(event.at, { dateStyle: "medium", timeStyle: "short", timeZone: timezone }),
        from: event.fromStatus,
        to: event.toStatus,
        note: event.note,
      })),
    };
  });
}

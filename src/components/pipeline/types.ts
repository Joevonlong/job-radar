import type { JobListItem } from "@/components/jobs/types";
import type { Overdue, StageClock } from "@/lib/dashboard/board";
import type { ApplicationStatus } from "@/lib/db/repos/applications";

import type { BoardSalary } from "./salary";

/** One entry of a card's timeline (a status change). Times are formatted on the server. */
export interface BoardEvent {
  id: number;
  when: string;
  from: ApplicationStatus | null;
  to: ApplicationStatus;
  note: string | null;
}

/** A pipeline card as the client components render it: plain serializable data. */
export interface BoardCard {
  jobId: number;
  /** The job as the lists show it (company, title, places, rank, signals). */
  job: JobListItem;
  status: ApplicationStatus;
  /** The stated annual salary (numbers; the component formats them); null = not disclosed. */
  salary: BoardSalary | null;
  /** Set when the card sat in `interested` / `applied` longer than notify.yaml `reminders` allows. */
  overdue: Overdue | null;
  /** Days in `interested` / `applied` next to the notify.yaml threshold (the bar on the card); null for other statuses. */
  clock: StageClock | null;
  nextAction: string | null;
  /** `YYYY-MM-DD`, the value of the date input. */
  nextActionDate: string | null;
  /** The date as the viewer reads it ("Oct 9"). */
  nextActionDateLabel: string | null;
  notes: string;
  interviewRounds: number;
  /** Newest first. */
  events: BoardEvent[];
}

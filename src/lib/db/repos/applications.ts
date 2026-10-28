import { and, asc, count, desc, eq, inArray, lt, sql } from "drizzle-orm";

import type { Db } from "../client";
import type { Executor } from "../executor";
import { applicationEvents, applications, applicationStatusEnum, companies, jobs } from "../schema";
import { PIPELINE_STATUSES } from "@/lib/dashboard/board";
import { wakeDormantJob } from "./dormancy";

export type Application = typeof applications.$inferSelect;
export type ApplicationEvent = typeof applicationEvents.$inferSelect;
export type ApplicationStatus = Application["status"];

/** All statuses, in pipeline order (the select on the detail page lists them in this order). */
export const APPLICATION_STATUSES: readonly ApplicationStatus[] = applicationStatusEnum.enumValues;

/** Applications per status (statuses without any are missing from the result). */
export async function countApplicationsByStatus(db: Executor): Promise<Partial<Record<ApplicationStatus, number>>> {
  const rows = await db.select({ status: applications.status, n: sql<number>`count(*)::int` }).from(applications).groupBy(applications.status);
  const counts: Partial<Record<ApplicationStatus, number>> = {};
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}

export async function getApplicationByJobId(db: Executor, jobId: number): Promise<Application | null> {
  const [row] = await db.select().from(applications).where(eq(applications.jobId, jobId)).limit(1);
  return row ?? null;
}

export async function listApplicationEvents(db: Db, applicationId: number, limit = 20): Promise<ApplicationEvent[]> {
  return db
    .select()
    .from(applicationEvents)
    .where(eq(applicationEvents.applicationId, applicationId))
    .orderBy(desc(applicationEvents.at), desc(applicationEvents.id))
    .limit(limit);
}

/** Application status per job (jobs without an application are absent from the map). */
export async function getApplicationStatuses(db: Db, jobIds: readonly number[]): Promise<Map<number, ApplicationStatus>> {
  if (jobIds.length === 0) return new Map();
  const rows = await db
    .select({ jobId: applications.jobId, status: applications.status })
    .from(applications)
    .where(inArray(applications.jobId, [...jobIds]));
  return new Map(rows.map((r) => [r.jobId, r.status]));
}

export interface StatusChange {
  /** Status before the call; null when the job had no application yet. */
  previous: ApplicationStatus | null;
  status: ApplicationStatus;
  /** false when the application already had this status (nothing was written). */
  changed: boolean;
  applicationId: number;
  /** Set (with nothing written) when `allowFrom` did not admit the current status; `previous` is that status. */
  rejected?: true;
}

export interface SetStatusOptions {
  /** Only move from these statuses (`new` stands for "no application yet"). A button press must not undo "applied". */
  allowFrom?: readonly ApplicationStatus[];
}

/**
 * Create the application of a job unless it exists. Returns the new row, or null when one was
 * already there (also when a concurrent call won the race: the unique key on `job_id` decides).
 * Creating writes the first event (`null → status`).
 */
async function createApplication(
  tx: Executor,
  input: { jobId: number; status: ApplicationStatus; notes?: string | null; note?: string | null },
): Promise<Application | null> {
  const [row] = await tx
    .insert(applications)
    .values({ jobId: input.jobId, status: input.status, notesMd: input.notes ?? null })
    .onConflictDoNothing({ target: applications.jobId })
    .returning();
  if (!row) return null;
  await tx.insert(applicationEvents).values({ applicationId: row.id, fromStatus: null, toStatus: row.status, note: input.note ?? null });
  if ((PIPELINE_STATUSES as readonly ApplicationStatus[]).includes(input.status)) await wakeDormantJob(tx, input.jobId);
  return row;
}

/**
 * Set the application status of a job. A job without an application gets one, with a single
 * `null → status` event; otherwise every real change writes one `from → to` event and a repeated
 * status writes nothing.
 */
export async function setApplicationStatus(
  db: Executor,
  jobId: number,
  status: ApplicationStatus,
  note?: string | null,
  options: SetStatusOptions = {},
): Promise<StatusChange> {
  const { allowFrom } = options;
  return db.transaction(async (tx) => {
    // an `allowFrom` that excludes `new` must not create the row, so check before the insert
    if (allowFrom && !allowFrom.includes("new")) {
      const [current] = await tx.select().from(applications).where(eq(applications.jobId, jobId)).limit(1);
      if (!current || (current.status !== status && !allowFrom.includes(current.status))) {
        return { previous: current?.status ?? null, status, changed: false, applicationId: current?.id ?? 0, rejected: true };
      }
    }
    const created = await createApplication(tx, { jobId, status, note });
    if (created) return { previous: null, status, changed: true, applicationId: created.id };

    const [existing] = await tx.select().from(applications).where(eq(applications.jobId, jobId)).for("update").limit(1);
    if (!existing) throw new Error(`setApplicationStatus: application of job ${jobId} vanished`);
    if (existing.status === status && (PIPELINE_STATUSES as readonly ApplicationStatus[]).includes(status)) await wakeDormantJob(tx, jobId);
    if (existing.status === status) return { previous: existing.status, status, changed: false, applicationId: existing.id };
    if (allowFrom && !allowFrom.includes(existing.status)) {
      return { previous: existing.status, status, changed: false, applicationId: existing.id, rejected: true };
    }

    await tx.update(applications).set({ status, statusChangedAt: sql`now()` }).where(eq(applications.id, existing.id));
    if ((PIPELINE_STATUSES as readonly ApplicationStatus[]).includes(status)) await wakeDormantJob(tx, jobId);
    await tx.insert(applicationEvents).values({ applicationId: existing.id, fromStatus: existing.status, toStatus: status, note: note ?? null });
    return { previous: existing.status, status, changed: true, applicationId: existing.id };
  });
}

export interface RevertResult {
  /** The status the application has now. */
  status: ApplicationStatus | null;
  /** true: the move was taken back (its event deleted, the old clock restored); false: history had moved on and a normal change was written instead. */
  reverted: boolean;
  changed: boolean;
}

/**
 * Take back the status change `restoreTo → movedTo`: the Undo of a toast. When the application is still in `movedTo` and the
 * newest event is exactly that move (`restoreTo → movedTo`), the event is deleted and the status and its clock (`status_changed_at`)
 * go back to what they were, so an undone move leaves no trace in the timeline and does not restart the "interested for N days" clock.
 * An application that the move itself created (`null → movedTo`, nothing else on it) is deleted again when `restoreTo` is `new`.
 * When anything else happened in between (another move, a later undo), history is not rewritten: the status is set to `restoreTo`
 * the normal way, which writes an honest `movedTo → restoreTo` event.
 */
export async function revertApplicationStatus(db: Executor, jobId: number, input: { movedTo: ApplicationStatus; restoreTo: ApplicationStatus }): Promise<RevertResult> {
  const { movedTo, restoreTo } = input;
  return db.transaction(async (tx) => {
    const [app] = await tx.select().from(applications).where(eq(applications.jobId, jobId)).for("update").limit(1);
    if (app && app.status === movedTo) {
      const events = await tx
        .select()
        .from(applicationEvents)
        .where(eq(applicationEvents.applicationId, app.id))
        .orderBy(desc(applicationEvents.at), desc(applicationEvents.id))
        .limit(2);
      const [latest, before] = events;
      // the move created the application (a job without one was ignored / starred from a list): taking it back removes the row again,
      // so the job is exactly as it was: no application, no events (its events go with it). Notes or a later event keep the row.
      if (latest && latest.fromStatus === null && latest.toStatus === movedTo && restoreTo === "new" && !before && app.notesMd === null) {
        await tx.delete(applications).where(eq(applications.id, app.id));
        return { status: null, reverted: true, changed: true };
      }
      if (latest && latest.fromStatus === restoreTo && latest.toStatus === movedTo) {
        await tx.delete(applicationEvents).where(eq(applicationEvents.id, latest.id));
        // the clock of the status it returns to started when the event before this one was written
        const since = before && before.toStatus === restoreTo ? before.at : app.createdAt;
        await tx.update(applications).set({ status: restoreTo, statusChangedAt: since }).where(eq(applications.id, app.id));
        if ((PIPELINE_STATUSES as readonly ApplicationStatus[]).includes(restoreTo)) await wakeDormantJob(tx, jobId);
        return { status: restoreTo, reverted: true, changed: true };
      }
    }
    const change = await setApplicationStatus(tx, jobId, restoreTo, null);
    return { status: change.status, reverted: false, changed: change.changed };
  });
}

/** Save the notes of a job's application (blank text clears them). Creates the application (status `new`) when there is none. */
export async function setApplicationNotes(db: Executor, jobId: number, notes: string): Promise<{ applicationId: number }> {
  const value = notes.trim() === "" ? null : notes;
  return db.transaction(async (tx) => {
    const created = await createApplication(tx, { jobId, status: "new", notes: value });
    if (created) return { applicationId: created.id };
    const [row] = await tx.update(applications).set({ notesMd: value }).where(eq(applications.jobId, jobId)).returning({ id: applications.id });
    if (!row) throw new Error(`setApplicationNotes: application of job ${jobId} vanished`);
    return { applicationId: row.id };
  });
}

/** Events of several applications, newest first within each application (the pipeline board's timelines). */
export async function listEventsByApplication(db: Executor, applicationIds: readonly number[]): Promise<Map<number, ApplicationEvent[]>> {
  const out = new Map<number, ApplicationEvent[]>();
  if (applicationIds.length === 0) return out;
  const rows = await db
    .select()
    .from(applicationEvents)
    .where(inArray(applicationEvents.applicationId, [...applicationIds]))
    .orderBy(desc(applicationEvents.at), desc(applicationEvents.id));
  for (const row of rows) {
    const list = out.get(row.applicationId) ?? [];
    list.push(row);
    out.set(row.applicationId, list);
  }
  return out;
}

export interface NextActionInput {
  /** Free text; null clears it. */
  nextAction: string | null;
  /** When it is due; null clears it. */
  nextActionAt: Date | null;
}

/** Set the next step (text and due date) of a job's application. false = the job has no application. */
export async function setApplicationNextAction(db: Executor, jobId: number, input: NextActionInput): Promise<boolean> {
  const rows = await db
    .update(applications)
    .set({ nextAction: input.nextAction, nextActionAt: input.nextActionAt })
    .where(eq(applications.jobId, jobId))
    .returning({ id: applications.id });
  return rows.length > 0;
}

/** Set the number of interview rounds of a job's application (clamped to `0..max`). Returns the stored value, or null when the job has no application. */
export async function setInterviewRounds(db: Executor, jobId: number, rounds: number, max: number): Promise<number | null> {
  const value = Math.min(Math.max(Math.trunc(rounds), 0), max);
  const rows = await db.update(applications).set({ interviewRounds: value }).where(eq(applications.jobId, jobId)).returning({ rounds: applications.interviewRounds });
  return rows[0]?.rounds ?? null;
}

export interface StaleApplication {
  jobId: number;
  title: string;
  companyName: string;
  statusChangedAt: Date;
}

/** Applications that have sat in `status` since before `before` (Telegram reminders): oldest first, plus the total. */
export async function listStaleApplications(
  db: Executor,
  input: { status: ApplicationStatus; before: Date; limit: number },
): Promise<{ total: number; items: StaleApplication[] }> {
  const where = and(eq(applications.status, input.status), lt(applications.statusChangedAt, input.before));
  const [totalRow] = await db.select({ n: count() }).from(applications).where(where);
  const items = await db
    .select({ jobId: applications.jobId, title: jobs.title, companyName: companies.name, statusChangedAt: applications.statusChangedAt })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(where)
    .orderBy(asc(applications.statusChangedAt), asc(applications.id))
    .limit(input.limit);
  return { total: totalRow?.n ?? 0, items };
}

/**
 * Attach a tailored resume PDF to a job's application (`null` detaches it). Creates the application
 * (status `new`) when there is none; the status is never touched here (the export sets `preparing`).
 */
export async function setApplicationResumePath(db: Executor, jobId: number, resumePath: string | null): Promise<{ applicationId: number }> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.update(applications).set({ resumeVariantPath: resumePath }).where(eq(applications.jobId, jobId)).returning({ id: applications.id });
    if (existing) return { applicationId: existing.id };
    const created = await createApplication(tx, { jobId, status: "new" });
    if (created) {
      await tx.update(applications).set({ resumeVariantPath: resumePath }).where(eq(applications.id, created.id));
      return { applicationId: created.id };
    }
    // a concurrent call created the row between our update and insert: update again
    const [raced] = await tx.update(applications).set({ resumeVariantPath: resumePath }).where(eq(applications.jobId, jobId)).returning({ id: applications.id });
    if (!raced) throw new Error(`setApplicationResumePath: application of job ${jobId} vanished`);
    return { applicationId: raced.id };
  });
}

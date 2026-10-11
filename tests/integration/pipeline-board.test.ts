import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from "vitest";

import { countInPipeline, overdueOf } from "@/lib/dashboard/board";
import {
  closeDb,
  getApplicationByJobId,
  getDb,
  getNavCounts,
  listApplicationEvents,
  listPipelineEntries,
  revertApplicationStatus,
  schema,
  setApplicationNextAction,
  setApplicationNotes,
  setApplicationStatus,
  setInterviewRounds,
} from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { seedDatabase } from "@/lib/db/seed";

const url = inject("testDatabaseUrl");
const TZ = "Europe/Berlin";
const NOW = new Date("2026-10-07T12:00:00Z");
const DAY_MS = 86_400_000;
const RESET = sql`truncate table jobs, companies, raw_postings, runs, cycles, channels, applications restart identity cascade`;

async function jobIdByTitle(title: string): Promise<number> {
  const [row] = await getDb().select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.title, title));
  if (!row) throw new Error(`no seeded job ${title}`);
  return row.id;
}

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

// Every test starts from the same freshly seeded board: no test depends on the moves an earlier one made.
beforeEach(async () => {
  await getDb().execute(RESET);
  await seedDatabase(getDb(), { now: NOW, timezone: TZ });
});

afterAll(async () => {
  // the test files share one database: leave it empty for the next file
  await getDb().execute(RESET);
  await closeDb();
});

describe("jobs in the pipeline: the board title, the column shares and the sidebar badge are one number", () => {
  it("counts the same set (not ended, `new` included) on the seeded board and in the nav counts", async () => {
    const db = getDb();
    // a job set to `new` (a note, an attached resume): an application row without a decision, a card in the first column
    await setApplicationStatus(db, await jobIdByTitle("Data Engineer"), "new");
    const entries = await listPipelineEntries(db);
    const board = entries.map((entry) => ({ status: entry.application.status }));
    const ended = board.filter((card) => ["rejected", "withdrawn", "archived"].includes(card.status)).length;
    const inPipeline = countInPipeline(board);
    expect(inPipeline).toBe(board.length - ended);
    // the seed has applications in `new` and in an ended status: both must make the difference visible
    expect(board.some((card) => card.status === "new")).toBe(true);
    expect(ended).toBeGreaterThan(0);
    const counts = await getNavCounts(db, { now: NOW, timezone: TZ });
    expect(counts.pipeline).toBe(inPipeline);
    // moving the `new` card to an ended status takes it out of both
    const newEntry = entries.find((entry) => entry.application.status === "new");
    if (!newEntry) throw new Error("no new entry");
    await setApplicationStatus(db, newEntry.job.id, "archived");
    expect((await getNavCounts(db, { now: NOW, timezone: TZ })).pipeline).toBe(inPipeline - 1);
  });
});

describe("listPipelineEntries", () => {
  it("returns exactly the jobs that have an application (status `new` included), best rank first, with their events", async () => {
    const db = getDb();
    const entries = await listPipelineEntries(db);
    const [applicationCount] = await db.execute<{ n: string }>(sql`select count(*) as n from applications`);
    expect(entries).toHaveLength(Number(applicationCount?.n));
    expect(entries.length).toBeGreaterThanOrEqual(5);
    for (const entry of entries) {
      expect(entry.application.jobId).toBe(entry.job.id);
      expect(entry.events.length).toBeGreaterThan(0);
      expect(entry.events.every((event) => event.applicationId === entry.application.id)).toBe(true);
    }
    // a job without an application is not on the board
    const idWithout = await jobIdByTitle("Data Engineer");
    expect(entries.map((e) => e.job.id)).not.toContain(idWithout);
    // best rank first (jobs without a rank value at the end)
    const ranks = entries.map((e) => e.job.rank?.rankValue ?? null);
    const ranked = ranks.filter((r): r is number => r !== null);
    expect(ranked).toEqual([...ranked].sort((a, b) => b - a));
    expect(ranks.indexOf(null) === -1 || ranks.slice(ranks.indexOf(null)).every((r) => r === null)).toBe(true);
  });

  it("shows a job whose application is in status `new` (a note alone, or set back to new) as a card of the first column", async () => {
    const db = getDb();
    const id = await jobIdByTitle("Data Engineer");
    expect((await listPipelineEntries(db)).map((e) => e.job.id)).not.toContain(id); // no application row: not on the board
    await setApplicationNotes(db, id, "just a note");
    expect((await listPipelineEntries(db)).find((e) => e.job.id === id)?.application.status).toBe("new");
    await setApplicationStatus(db, id, "interested");
    expect((await listPipelineEntries(db)).find((e) => e.job.id === id)?.application.status).toBe("interested");
    await setApplicationStatus(db, id, "new");
    expect((await listPipelineEntries(db)).find((e) => e.job.id === id)?.application.status).toBe("new");
  });

  it("carries the card data of the lists: company, signals, status", async () => {
    const entries = await listPipelineEntries(getDb());
    const quillfeather = entries.find((e) => e.job.companyName === "Quillfeather Labs");
    expect(quillfeather?.application.status).toBe("interested");
    expect(quillfeather?.job.applicationStatus).toBe("interested");
    expect(quillfeather?.job.signals.map((s) => s.tier)).toEqual(expect.arrayContaining(["T1", "T2"]));
    expect(quillfeather?.job.rank?.rankValue).not.toBeNull();
  });

  it("includes a job that the hard filter removed once the user moved it into the pipeline", async () => {
    const db = getDb();
    const [filtered] = await db.select({ jobId: schema.scores.jobId }).from(schema.scores).where(eq(schema.scores.filterResult, "filtered_out")).limit(1);
    if (!filtered) throw new Error("seed has no filtered job");
    await setApplicationStatus(db, filtered.jobId, "interested");
    const entry = (await listPipelineEntries(db)).find((e) => e.job.id === filtered.jobId);
    expect(entry?.job.rank?.filterResult).toBe("filtered_out");
  });

  it("orders events newest first and lists every status change", async () => {
    const db = getDb();
    const id = await jobIdByTitle("Security Engineer, Cloud");
    await setApplicationStatus(db, id, "interested");
    await setApplicationStatus(db, id, "preparing");
    await setApplicationStatus(db, id, "applied");
    const entry = (await listPipelineEntries(db)).find((e) => e.job.id === id);
    expect(entry?.events.map((e) => [e.fromStatus, e.toStatus])).toEqual([
      ["preparing", "applied"],
      ["interested", "preparing"],
      [null, "interested"],
    ]);
  });
});

describe("board moves", () => {
  it("writes exactly one event per status change, none for a repeat, and keeps notes", async () => {
    const db = getDb();
    const id = await jobIdByTitle("Computer Vision Engineer");
    await setApplicationNotes(db, id, "keep me");
    const move = await setApplicationStatus(db, id, "interested");
    expect(move.changed).toBe(true);
    await setApplicationStatus(db, id, "interested");
    await setApplicationStatus(db, id, "withdrawn");
    const events = await listApplicationEvents(db, move.applicationId);
    expect(events.map((e) => [e.fromStatus, e.toStatus])).toEqual([
      ["interested", "withdrawn"],
      ["new", "interested"],
      [null, "new"],
    ]);
    expect((await getApplicationByJobId(db, id))?.notesMd).toBe("keep me");
  });
});

describe("undo of a move", () => {
  it("deletes the move event and restores the status and its clock, leaving no extra events", async () => {
    const db = getDb();
    const id = await jobIdByTitle("Security Engineer, Cloud");
    const first = await setApplicationStatus(db, id, "interested");
    // pretend the job has been `interested` for 9 days
    const since = new Date(NOW.getTime() - 9 * DAY_MS);
    await db.execute(sql`update applications set status_changed_at = ${since.toISOString()}::timestamptz where id = ${first.applicationId}`);
    await db.execute(sql`update application_events set at = ${since.toISOString()}::timestamptz where application_id = ${first.applicationId}`);
    await setApplicationStatus(db, id, "preparing");

    const result = await revertApplicationStatus(db, id, { movedTo: "preparing", restoreTo: "interested" });
    expect(result).toMatchObject({ status: "interested", reverted: true, changed: true });
    const app = await getApplicationByJobId(db, id);
    expect(app?.status).toBe("interested");
    expect(app?.statusChangedAt.getTime()).toBe(since.getTime()); // the "interested for 9 days" clock did not restart
    const events = await listApplicationEvents(db, first.applicationId);
    expect(events.map((e) => [e.fromStatus, e.toStatus])).toEqual([[null, "interested"]]);
  });

  it("removes an application that the ignored move itself created (ignore + undo leaves no row and no events)", async () => {
    const db = getDb();
    const id = await jobIdByTitle("Machine Learning Engineer, Perception");
    // an application of this seeded job may exist: use a job that has none
    const [free] = await db.execute<{ id: number }>(sql`select j.id from jobs j where not exists (select 1 from applications a where a.job_id = j.id) limit 1`);
    const jobId = free?.id ?? id;
    expect(await getApplicationByJobId(db, jobId)).toBeNull();
    const moved = await setApplicationStatus(db, jobId, "archived");
    expect(moved.previous).toBeNull();

    const result = await revertApplicationStatus(db, jobId, { movedTo: "archived", restoreTo: "new" });
    expect(result).toMatchObject({ status: null, reverted: true });
    expect(await getApplicationByJobId(db, jobId)).toBeNull();
    const [events] = await db.execute<{ n: number }>(sql`select count(*)::int as n from application_events where application_id = ${moved.applicationId}`);
    expect(events?.n).toBe(0);
  });

  it("keeps the application of an ignored job that has notes (the undo writes a normal change)", async () => {
    const db = getDb();
    const [free] = await db.execute<{ id: number }>(sql`select j.id from jobs j where not exists (select 1 from applications a where a.job_id = j.id) limit 1`);
    if (!free) throw new Error("the seed has no job without an application");
    await setApplicationNotes(db, free.id, "keep me");
    await setApplicationStatus(db, free.id, "archived");
    const result = await revertApplicationStatus(db, free.id, { movedTo: "archived", restoreTo: "new" });
    expect(result.reverted).toBe(true);
    expect(await getApplicationByJobId(db, free.id)).toMatchObject({ status: "new", notesMd: "keep me" });
  });

  it("writes a normal change when the history has moved on since the move", async () => {
    const db = getDb();
    const id = await jobIdByTitle("Security Engineer, Cloud");
    const first = await setApplicationStatus(db, id, "interested");
    await setApplicationStatus(db, id, "preparing");
    await setApplicationStatus(db, id, "applied");
    // undo of the first move, but the newest event is another one: nothing is rewritten
    const result = await revertApplicationStatus(db, id, { movedTo: "preparing", restoreTo: "interested" });
    expect(result.reverted).toBe(false);
    const events = await listApplicationEvents(db, first.applicationId);
    expect(events.map((e) => [e.fromStatus, e.toStatus])).toEqual([
      ["applied", "interested"],
      ["preparing", "applied"],
      ["interested", "preparing"],
      [null, "interested"],
    ]);
  });
});

describe("next step and interview rounds", () => {
  it("stores and clears the next step and its date", async () => {
    const db = getDb();
    const id = await jobIdByTitle("Senior Backend Engineer (Python)");
    const due = new Date("2026-12-24T12:00:00Z");
    expect(await setApplicationNextAction(db, id, { nextAction: "Send CV", nextActionAt: due })).toBe(true);
    expect(await getApplicationByJobId(db, id)).toMatchObject({ nextAction: "Send CV", nextActionAt: due });
    expect(await setApplicationNextAction(db, id, { nextAction: null, nextActionAt: null })).toBe(true);
    expect(await getApplicationByJobId(db, id)).toMatchObject({ nextAction: null, nextActionAt: null });
  });

  it("does not create an application for the next step of a job without one", async () => {
    const db = getDb();
    const id = await jobIdByTitle("Data Engineer");
    expect(await setApplicationNextAction(db, id, { nextAction: "x", nextActionAt: null })).toBe(false);
    expect(await getApplicationByJobId(db, id)).toBeNull();
  });

  it("keeps interview rounds within 0..max and does not write status events", async () => {
    const db = getDb();
    const id = await jobIdByTitle("Senior Backend Engineer (Python)");
    const application = await getApplicationByJobId(db, id);
    if (!application) throw new Error("seed application missing");
    const eventsBefore = (await listApplicationEvents(db, application.id)).length;
    expect(await setInterviewRounds(db, id, 3, 20)).toBe(3);
    expect(await setInterviewRounds(db, id, -4, 20)).toBe(0);
    expect(await setInterviewRounds(db, id, 99, 20)).toBe(20);
    expect(await setInterviewRounds(db, id, 0, 20)).toBe(0);
    expect(await setInterviewRounds(db, await jobIdByTitle("Data Engineer"), 1, 20)).toBeNull();
    expect((await listApplicationEvents(db, application.id)).length).toBe(eventsBefore);
  });

  it("shows up in the board entries", async () => {
    const db = getDb();
    const id = await jobIdByTitle("Senior Backend Engineer (Python)");
    await setInterviewRounds(db, id, 2, 20);
    await setApplicationNextAction(db, id, { nextAction: "Prepare system design", nextActionAt: null });
    const entry = (await listPipelineEntries(db)).find((e) => e.job.id === id);
    expect(entry?.application).toMatchObject({ interviewRounds: 2, nextAction: "Prepare system design" });
  });
});

describe("overdue from the stored status time", () => {
  it("uses the seeded ages: interested 9 days and applied 16 days are overdue under the shipped thresholds", async () => {
    const entries = await listPipelineEntries(getDb());
    const thresholds = { interestedDays: 7, appliedDays: 14 };
    const byCompany = (name: string) => entries.find((e) => e.job.companyName === name);
    const interested = byCompany("Quillfeather Labs");
    const applied = byCompany("Tidewater Robotics");
    expect(interested && overdueOf(interested.application.status, interested.application.statusChangedAt, NOW, thresholds)).toEqual({ kind: "interested", days: 9 });
    expect(applied && overdueOf(applied.application.status, applied.application.statusChangedAt, NOW, thresholds)).toEqual({ kind: "applied", days: 16 });
    // a looser configuration (notify.yaml) clears both
    expect(interested && overdueOf(interested.application.status, interested.application.statusChangedAt, NOW, { interestedDays: 10, appliedDays: 20 })).toBeNull();
    expect(applied && overdueOf(applied.application.status, applied.application.statusChangedAt, NOW, { interestedDays: 10, appliedDays: 20 })).toBeNull();
    expect(NOW.getTime() - (interested?.application.statusChangedAt.getTime() ?? 0)).toBe(9 * DAY_MS);
  });

  it("restarts the clock when the status changes", async () => {
    const db = getDb();
    const id = await jobIdByTitle("Forward Deployed Engineer");
    const before = await getApplicationByJobId(db, id);
    await setApplicationStatus(db, id, "preparing");
    const after = await getApplicationByJobId(db, id);
    expect(after && before && after.statusChangedAt.getTime() > before.statusChangedAt.getTime()).toBe(true);
  });
});

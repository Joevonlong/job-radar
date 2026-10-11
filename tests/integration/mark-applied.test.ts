import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { markAppliedAction } from "@/app/jobs/[id]/actions";
import { undoApplicationStatusAction } from "@/app/pipeline/actions";
import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { APPLICATION_STATUSES, setApplicationStatus, type ApplicationStatus } from "@/lib/db/repos/applications";
import { getOrCreateCompany } from "@/lib/db/repos/companies";
import { insertJob } from "@/lib/db/repos/jobs";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const url = inject("testDatabaseUrl");

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});
beforeEach(async () => {
  await getDb().execute(sql`truncate table jobs, companies restart identity cascade`);
});
afterAll(async () => {
  await getDb().execute(sql`truncate table jobs, companies restart identity cascade`);
  await closeDb();
});

async function newJob(status: ApplicationStatus | null): Promise<number> {
  const db = getDb();
  const company = await getOrCreateCompany(db, { name: "Acme", nameNorm: "acme" });
  const job = await insertJob(db, { companyId: company.id, title: "SRE", titleNorm: "sre" });
  if (status !== null) await setApplicationStatus(db, job.id, status);
  return job.id;
}

async function events(jobId: number): Promise<{ from: string | null; to: string }[]> {
  const rows = await getDb()
    .select({ from: schema.applicationEvents.fromStatus, to: schema.applicationEvents.toStatus })
    .from(schema.applicationEvents)
    .innerJoin(schema.applications, eq(schema.applications.id, schema.applicationEvents.applicationId))
    .where(eq(schema.applications.jobId, jobId))
    .orderBy(schema.applicationEvents.id);
  return rows;
}

async function statusOf(jobId: number): Promise<ApplicationStatus | null> {
  const [row] = await getDb().select({ status: schema.applications.status }).from(schema.applications).where(eq(schema.applications.jobId, jobId));
  return row?.status ?? null;
}

describe("markAppliedAction", () => {
  it("creates the application for a job that has none (null -> applied)", async () => {
    const id = await newJob(null);
    expect(await markAppliedAction({ jobId: id })).toEqual({ ok: true, previous: null, status: "applied", changed: true });
    expect(await statusOf(id)).toBe("applied");
    expect(await events(id)).toEqual([{ from: null, to: "applied" }]);
  });

  it.each(["new", "interested", "preparing", "archived"] as const)("moves %s to applied and writes one event", async (from) => {
    const id = await newJob(from);
    const before = (await events(id)).length;
    expect(await markAppliedAction({ jobId: id })).toEqual({ ok: true, previous: from, status: "applied", changed: true });
    expect(await statusOf(id)).toBe("applied");
    const after = await events(id);
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toEqual({ from, to: "applied" });
  });

  it("is a no-op for a job that is already applied", async () => {
    const id = await newJob("applied");
    const before = await events(id);
    expect(await markAppliedAction({ jobId: id })).toEqual({ ok: true, previous: "applied", status: "applied", changed: false });
    expect(await events(id)).toEqual(before);
  });

  it.each(APPLICATION_STATUSES.filter((s) => ["interviewing", "offer", "rejected", "withdrawn"].includes(s)))("refuses %s and writes nothing", async (from) => {
    const id = await newJob(from);
    const before = await events(id);
    expect(await markAppliedAction({ jobId: id })).toEqual({ ok: false, error: "not_allowed" });
    expect(await statusOf(id)).toBe(from);
    expect(await events(id)).toEqual(before);
  });

  it("rejects bad input and unknown jobs", async () => {
    expect(await markAppliedAction({ jobId: 0 })).toEqual({ ok: false, error: "invalid" });
    expect(await markAppliedAction({ jobId: 1.5 })).toEqual({ ok: false, error: "invalid" });
    expect(await markAppliedAction({ jobId: 99999 })).toEqual({ ok: false, error: "not_found" });
  });

  it("undo restores the old status and deletes the event", async () => {
    const id = await newJob("interested");
    const before = await events(id);
    await markAppliedAction({ jobId: id });
    expect(await undoApplicationStatusAction({ jobId: id, movedTo: "applied", restoreTo: "interested" })).toEqual({ ok: true, status: "interested" });
    expect(await statusOf(id)).toBe("interested");
    expect(await events(id)).toEqual(before);
  });

  it("undo removes an application the mark created", async () => {
    const id = await newJob(null);
    await markAppliedAction({ jobId: id });
    await undoApplicationStatusAction({ jobId: id, movedTo: "applied", restoreTo: "new" });
    expect(await statusOf(id)).toBeNull();
    expect(await events(id)).toEqual([]);
  });
});

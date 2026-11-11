import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { afterAll, beforeAll, expect, inject, it, vi } from "vitest";

import { setApplicationStatusAction } from "@/app/jobs/[id]/actions";
import { saveNextActionAction, setInterviewRoundsAction } from "@/app/pipeline/actions";
import { closeDb, getDb, schema } from "@/lib/db";
import { getApplicationByJobId, listApplicationEvents, setApplicationNotes, setApplicationStatus } from "@/lib/db/repos/applications";
import { getOrCreateCompany } from "@/lib/db/repos/companies";
import { insertJob } from "@/lib/db/repos/jobs";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const trigger = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/research/auto", async (original) => ({ ...await original<typeof import("@/lib/research/auto")>(), triggerAutoResearch: trigger }));
beforeAll(() => { process.env.DATABASE_URL = inject("testDatabaseUrl"); });
afterAll(closeDb);

async function fixture() {
  const db = getDb();
  const company = await getOrCreateCompany(db, { name: "Example", nameNorm: "example" });
  const job = await insertJob(db, { companyId: company.id, title: "Engineer", titleNorm: "engineer" });
  await setApplicationStatus(db, job.id, "offer");
  await setApplicationNotes(db, job.id, "PRIVATE-NOTE-PRESERVED");
  vi.clearAllMocks();
  return job.id;
}

it("ordinary status changes append events and trigger research only on a real qualifying change", async () => {
  const id = await fixture();
  expect(await setApplicationStatusAction({ jobId: id, status: "preparing" })).toEqual({ ok: true, previous: "offer", status: "preparing", changed: true });
  const app = await getApplicationByJobId(getDb(), id);
  expect(app?.notesMd).toBe("PRIVATE-NOTE-PRESERVED");
  const events = await listApplicationEvents(getDb(), app!.id);
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ fromStatus: "offer", toStatus: "preparing" });
  expect(trigger).toHaveBeenCalledExactlyOnceWith(getDb(), { jobId: id, event: "status" });
  expect(await setApplicationStatusAction({ jobId: id, status: "preparing" })).toEqual({ ok: true, previous: "preparing", status: "preparing", changed: false });
  expect(await listApplicationEvents(getDb(), app!.id)).toEqual(events);
  expect(trigger).toHaveBeenCalledTimes(1);
  expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
});

it("next step and rounds alter only their fields, leaving status, notes and events intact", async () => {
  const id = await fixture();
  const app = await getApplicationByJobId(getDb(), id);
  const events = await listApplicationEvents(getDb(), app!.id);
  expect(await saveNextActionAction({ jobId: id, nextAction: "  Call back  ", nextActionDate: "2026-12-24" })).toEqual({ ok: true });
  expect(await setInterviewRoundsAction({ jobId: id, rounds: 3 })).toEqual({ ok: true, rounds: 3 });
  expect(await getApplicationByJobId(getDb(), id)).toEqual({ ...app, nextAction: "Call back", nextActionAt: new Date("2026-12-24T12:00:00Z"), interviewRounds: 3 });
  expect(await listApplicationEvents(getDb(), app!.id)).toEqual(events);
  expect(trigger).not.toHaveBeenCalled();
  expect(revalidatePath).toHaveBeenCalledWith("/pipeline");
  await saveNextActionAction({ jobId: id, nextAction: "  ", nextActionDate: null });
  expect(await getApplicationByJobId(getDb(), id)).toMatchObject({ nextAction: null, nextActionAt: null });
  await getDb().delete(schema.applications).where(eq(schema.applications.jobId, id));
  expect(await saveNextActionAction({ jobId: id, nextAction: "Next", nextActionDate: null })).toEqual({ ok: false, error: "not_found" });
  expect(await setInterviewRoundsAction({ jobId: id, rounds: 1 })).toEqual({ ok: false, error: "not_found" });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import { revalidatePath } from "next/cache";
import { markAppliedAction, saveApplicationNotesAction, setApplicationStatusAction } from "@/app/jobs/[id]/actions";
import { saveNextActionAction, setInterviewRoundsAction, undoApplicationStatusAction } from "@/app/pipeline/actions";
import { MARK_APPLIED_FROM } from "@/lib/dashboard/apply";
import { INTERVIEW_ROUNDS_MAX, NEXT_ACTION_MAX_CHARS } from "@/lib/dashboard/limits";
import { nextActionDateToTimestamp } from "@/lib/dashboard/board";

const mocks = vi.hoisted(() => ({
  db: {}, jobExists: vi.fn(), setApplicationStatus: vi.fn(), setApplicationNotes: vi.fn(),
  setApplicationNextAction: vi.fn(), setInterviewRounds: vi.fn(), revertApplicationStatus: vi.fn(), triggerAutoResearch: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", async (original) => ({ ...await original<typeof import("@/lib/db")>(), ...mocks, getDb: () => mocks.db }));
vi.mock("@/lib/research/auto", async (original) => ({ ...await original<typeof import("@/lib/research/auto")>(), triggerAutoResearch: mocks.triggerAutoResearch }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.jobExists.mockResolvedValue(true);
  mocks.setApplicationStatus.mockResolvedValue({ applicationId: 12, previous: "new", status: "interested", changed: true });
  mocks.setApplicationNextAction.mockResolvedValue(true);
  mocks.setInterviewRounds.mockResolvedValue(2);
});

describe("application actions before service extraction", () => {
  it("validates before writing and refreshes every status view after a valid change", async () => {
    expect(await setApplicationStatusAction({ jobId: 0, status: "interested" })).toEqual({ ok: false, error: "invalid" });
    expect(await setApplicationStatusAction({ jobId: 7, status: "unknown" })).toEqual({ ok: false, error: "invalid" });
    expect(mocks.setApplicationStatus).not.toHaveBeenCalled();
    expect(await setApplicationStatusAction({ jobId: 7, status: "interested" })).toEqual({ ok: true, previous: "new", status: "interested", changed: true });
    expect(mocks.setApplicationStatus).toHaveBeenCalledWith(mocks.db, 7, "interested");
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(mocks.triggerAutoResearch).toHaveBeenCalledWith(mocks.db, { jobId: 7, event: "status" });
    expect(mocks.setApplicationNotes).not.toHaveBeenCalled();
  });

  it("allows ordinary selection of a status even from a later stage", async () => {
    mocks.setApplicationStatus.mockResolvedValue({ previous: "offer", status: "preparing", changed: true });
    expect(await setApplicationStatusAction({ jobId: 7, status: "preparing" })).toEqual({ ok: true, previous: "offer", status: "preparing", changed: true });
    expect(mocks.setApplicationStatus).toHaveBeenCalledWith(mocks.db, 7, "preparing");
  });

  it("mark applied uses the allowFrom rule, and refuses without refresh or research", async () => {
    mocks.setApplicationStatus.mockResolvedValue({ previous: "offer", status: "applied", changed: false, rejected: true });
    expect(await markAppliedAction({ jobId: 7 })).toEqual({ ok: false, error: "not_allowed" });
    expect(mocks.setApplicationStatus).toHaveBeenCalledWith(mocks.db, 7, "applied", null, { allowFrom: MARK_APPLIED_FROM });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(mocks.triggerAutoResearch).not.toHaveBeenCalled();
  });

  it("an already applied job is a successful no-op without research", async () => {
    mocks.setApplicationStatus.mockResolvedValue({ previous: "applied", status: "applied", changed: false });
    expect(await markAppliedAction({ jobId: 7 })).toEqual({ ok: true, previous: "applied", status: "applied", changed: false });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(mocks.triggerAutoResearch).not.toHaveBeenCalled();
  });

  it("unknown jobs do not write", async () => {
    mocks.jobExists.mockResolvedValue(false);
    expect(await setApplicationStatusAction({ jobId: 7, status: "interested" })).toEqual({ ok: false, error: "not_found" });
    expect(await markAppliedAction({ jobId: 7 })).toEqual({ ok: false, error: "not_found" });
    expect(mocks.setApplicationStatus).not.toHaveBeenCalled();
  });

  it("trims the next step, converts dates and clears blanks, refreshing only the pipeline", async () => {
    expect(await saveNextActionAction({ jobId: 7, nextAction: " Send CV ", nextActionDate: "2026-12-24" })).toEqual({ ok: true });
    expect(mocks.setApplicationNextAction).toHaveBeenCalledWith(mocks.db, 7, { nextAction: "Send CV", nextActionAt: nextActionDateToTimestamp("2026-12-24") });
    expect(await saveNextActionAction({ jobId: 7, nextAction: "  ", nextActionDate: "" })).toEqual({ ok: true });
    expect(mocks.setApplicationNextAction).toHaveBeenLastCalledWith(mocks.db, 7, { nextAction: null, nextActionAt: null });
    expect(revalidatePath).toHaveBeenCalledWith("/pipeline");
    expect(mocks.setApplicationNotes).not.toHaveBeenCalled();
  });

  it("rejects invalid next steps and missing applications", async () => {
    expect(await saveNextActionAction({ jobId: 7, nextAction: "x".repeat(NEXT_ACTION_MAX_CHARS + 1), nextActionDate: null })).toEqual({ ok: false, error: "invalid" });
    expect(await saveNextActionAction({ jobId: 7, nextAction: "x", nextActionDate: "2026-02-30" })).toEqual({ ok: false, error: "invalid" });
    mocks.setApplicationNextAction.mockResolvedValue(false);
    expect(await saveNextActionAction({ jobId: 7, nextAction: "x", nextActionDate: null })).toEqual({ ok: false, error: "not_found" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("validates rounds, returns the stored value and preserves notes", async () => {
    expect(await setInterviewRoundsAction({ jobId: 7, rounds: INTERVIEW_ROUNDS_MAX + 1 })).toEqual({ ok: false, error: "invalid" });
    expect(await setInterviewRoundsAction({ jobId: 7, rounds: 2 })).toEqual({ ok: true, rounds: 2 });
    expect(mocks.setInterviewRounds).toHaveBeenCalledWith(mocks.db, 7, 2, INTERVIEW_ROUNDS_MAX);
    expect(revalidatePath).toHaveBeenCalledWith("/pipeline");
    expect(mocks.setApplicationNotes).not.toHaveBeenCalled();
    mocks.setInterviewRounds.mockResolvedValue(null);
    expect(await setInterviewRoundsAction({ jobId: 7, rounds: 2 })).toEqual({ ok: false, error: "not_found" });
  });

  it("keeps the toast undo on the repository revert path", async () => {
    mocks.revertApplicationStatus.mockResolvedValue({ status: "new", changed: true, reverted: false });
    expect(await undoApplicationStatusAction({ jobId: 7, movedTo: "interested", restoreTo: "new" })).toEqual({ ok: true, status: "new" });
    expect(mocks.revertApplicationStatus).toHaveBeenCalledWith(mocks.db, 7, { movedTo: "interested", restoreTo: "new" });
    expect(mocks.triggerAutoResearch).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("notes keep the original text and remain independent of status", async () => {
    expect(await saveApplicationNotesAction({ jobId: 7, notes: "  private note  " })).toEqual({ ok: true });
    expect(mocks.setApplicationNotes).toHaveBeenCalledWith(mocks.db, 7, "  private note  ");
    expect(mocks.setApplicationStatus).not.toHaveBeenCalled();
    expect(mocks.triggerAutoResearch).not.toHaveBeenCalled();
  });
});

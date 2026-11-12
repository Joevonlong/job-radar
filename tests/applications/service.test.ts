import { beforeEach, expect, it, vi } from "vitest";

import { changeApplicationStatus, markApplied, setInterviewRounds, setNextAction } from "@/lib/applications/service";
import type { Executor } from "@/lib/db/executor";

const mocks = vi.hoisted(() => ({ jobExists: vi.fn(), setApplicationStatus: vi.fn(), setApplicationNextAction: vi.fn(), setInterviewRounds: vi.fn(), triggerAutoResearch: vi.fn() }));
vi.mock("@/lib/db", () => mocks);
vi.mock("@/lib/research/auto", () => ({ triggerAutoResearch: mocks.triggerAutoResearch, statusStartsResearch: (status: string) => ["interested", "preparing", "applied"].includes(status) }));
const db = {} as Executor;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.jobExists.mockResolvedValue(true);
  mocks.setApplicationStatus.mockResolvedValue({ previous: "new", status: "applied", changed: true });
  mocks.triggerAutoResearch.mockResolvedValue({ outcome: "budget_skipped", items: {} });
});

it.each(["stdio", 12] as const)("propagates trusted caller %s and returns the budget skip without rejecting the write", async (caller) => {
  expect(await changeApplicationStatus(db, { jobId: 9, status: "applied" }, caller)).toMatchObject({ ok: true, changed: true, research: "budget_skipped" });
  expect(mocks.triggerAutoResearch).toHaveBeenCalledWith(db, { jobId: 9, event: "status", caller });
});
it("the owner does not wait for automatic research", async () => {
  mocks.triggerAutoResearch.mockReturnValue(new Promise(() => {}));
  expect(await markApplied(db, { jobId: 9 }, undefined)).toMatchObject({ ok: true, research: null });
  expect(mocks.triggerAutoResearch).toHaveBeenCalledWith(db, { jobId: 9, event: "status" });
});
it("a rejected transition never starts research", async () => {
  mocks.setApplicationStatus.mockResolvedValue({ previous: "offer", status: "applied", changed: false, rejected: true });
  expect(await markApplied(db, { jobId: 9 }, "stdio")).toEqual({ ok: false, error: "not_allowed" });
  expect(mocks.triggerAutoResearch).not.toHaveBeenCalled();
});
it("next step and rounds use the same stores for owner and agent", async () => {
  mocks.setApplicationNextAction.mockResolvedValue(true);
  mocks.setInterviewRounds.mockResolvedValue(4);
  for (const caller of [undefined, "stdio"] as const) {
    expect(await setNextAction(db, { jobId: 9, nextAction: null, nextActionAt: null }, caller)).toBe(true);
    expect(await setInterviewRounds(db, { jobId: 9, rounds: 4 }, caller)).toBe(4);
  }
  expect(mocks.setApplicationNextAction.mock.calls[0]).toEqual(mocks.setApplicationNextAction.mock.calls[1]);
  expect(mocks.setInterviewRounds.mock.calls[0]).toEqual(mocks.setInterviewRounds.mock.calls[1]);
  expect(mocks.triggerAutoResearch).not.toHaveBeenCalled();
});

import type { AgentCaller } from "@/lib/agent-access/caller";
import { MARK_APPLIED_FROM } from "@/lib/dashboard/apply";
import { INTERVIEW_ROUNDS_MAX } from "@/lib/dashboard/limits";
import { jobExists, setApplicationNextAction, setApplicationStatus, setInterviewRounds as storeInterviewRounds, type ApplicationStatus } from "@/lib/db";
import type { Executor } from "@/lib/db/executor";
import type { NextActionInput, StatusChange } from "@/lib/db/repos/applications";
import { statusStartsResearch, triggerAutoResearch, type AutoResearchOutcome } from "@/lib/research/auto";

export type ApplicationStatusResult =
  | { ok: true; previous: ApplicationStatus | null; status: ApplicationStatus; changed: boolean; research: AutoResearchOutcome | null }
  | { ok: false; error: "not_found" | "not_allowed" };

/** Owner actions keep their fire-and-forget trigger; agents await the budget decision inside their write transaction. */
async function changedStatus(db: Executor, jobId: number, change: StatusChange, caller: AgentCaller | undefined): Promise<ApplicationStatusResult> {
  if (change.rejected) return { ok: false, error: "not_allowed" };
  let research: AutoResearchOutcome | null = null;
  if (change.changed && statusStartsResearch(change.status)) {
    if (caller === undefined) void triggerAutoResearch(db, { jobId, event: "status" });
    else research = (await triggerAutoResearch(db, { jobId, event: "status", caller })).outcome;
  }
  return { ok: true, previous: change.previous, status: change.status, changed: change.changed, research };
}

export async function changeApplicationStatus(db: Executor, input: { jobId: number; status: ApplicationStatus }, caller: AgentCaller | undefined): Promise<ApplicationStatusResult> {
  if (!(await jobExists(db, input.jobId))) return { ok: false, error: "not_found" };
  return changedStatus(db, input.jobId, await setApplicationStatus(db, input.jobId, input.status), caller);
}

export async function markApplied(db: Executor, input: { jobId: number }, caller: AgentCaller | undefined): Promise<ApplicationStatusResult> {
  if (!(await jobExists(db, input.jobId))) return { ok: false, error: "not_found" };
  const change = await setApplicationStatus(db, input.jobId, "applied", null, { allowFrom: MARK_APPLIED_FROM });
  return changedStatus(db, input.jobId, change, caller);
}

export async function setNextAction(db: Executor, input: NextActionInput & { jobId: number }, caller: AgentCaller | undefined): Promise<boolean> {
  void caller;
  return setApplicationNextAction(db, input.jobId, { nextAction: input.nextAction, nextActionAt: input.nextActionAt });
}

export async function setInterviewRounds(db: Executor, input: { jobId: number; rounds: number }, caller: AgentCaller | undefined): Promise<number | null> {
  void caller;
  return storeInterviewRounds(db, input.jobId, input.rounds, INTERVIEW_ROUNDS_MAX);
}

import { desc, eq, ne } from "drizzle-orm";

import type { Db } from "../client";
import type { CycleKind } from "../repos/cycles";
import { countUnscoredJobs } from "../repos/scores";
import { problemSteps, readCycleSteps, type StepName } from "@/lib/cycle/step-health";
import { channels, cycles, runs } from "../schema";
import { getOpenAiRun } from "./ai-run";
import { getCycleProgress } from "./sources";

/** What the sidebar's cycle status needs: the newest cycle, how its sources did, and the AI part while it is open. */
export interface ShellCycleStatus {
  cycle: { id: number; kind: CycleKind; status: "running" | "succeeded" | "partial" | "failed"; runsTotal: number; runsFinished: number; failedSteps: StepName[]; partialSteps: StepName[] } | null;
  /** Channels of that cycle by outcome: ok / failed this run / behind an open circuit. */
  sources: { ok: number; failed: number; circuitOpen: number } | null;
  /** The open `run_ai` request: postings scored so far and the total (scored + still waiting). */
  ai: { status: "pending" | "running"; kind: CycleKind | null; scored: number; total: number } | null;
}

/** The newest cycle that actually ran (skipped ones did nothing), the same one the Today strip shows. */
async function latestCycleId(db: Db): Promise<number | null> {
  const [row] = await db.select({ id: cycles.id }).from(cycles).where(ne(cycles.status, "skipped")).orderBy(desc(cycles.startedAt), desc(cycles.id)).limit(1);
  return row?.id ?? null;
}

async function channelOutcomes(db: Db, cycleId: number): Promise<NonNullable<ShellCycleStatus["sources"]>> {
  const rows = await db
    .select({ channelId: runs.channelId, status: runs.status, circuitState: channels.circuitState })
    .from(runs)
    .innerJoin(channels, eq(channels.id, runs.channelId))
    .where(eq(runs.cycleId, cycleId));
  const byChannel = new Map<string, "ok" | "failed" | "skipped" | "circuitOpen">();
  for (const row of rows) {
    const current = byChannel.get(row.channelId) ?? "ok";
    let next = current;
    if (row.status === "failed" && current !== "circuitOpen") next = "failed";
    if (row.status === "skipped" && current === "ok") next = "skipped";
    if (row.circuitState === "open") next = "circuitOpen";
    byChannel.set(row.channelId, next);
  }
  const outcomes = [...byChannel.values()];
  return {
    ok: outcomes.filter((o) => o === "ok").length,
    failed: outcomes.filter((o) => o === "failed").length,
    circuitOpen: outcomes.filter((o) => o === "circuitOpen").length,
  };
}

/** Which steps of the cycle failed or ended partial (from `cycles.summary_json`). */
async function cycleStepProblems(db: Db, cycleId: number): Promise<{ failed: StepName[]; partial: StepName[] }> {
  const [row] = await db.select({ summaryJson: cycles.summaryJson }).from(cycles).where(eq(cycles.id, cycleId)).limit(1);
  return problemSteps(readCycleSteps(row?.summaryJson));
}

export async function getShellCycleStatus(db: Db): Promise<ShellCycleStatus> {
  const [cycleId, aiRun] = await Promise.all([latestCycleId(db), getOpenAiRun(db)]);
  const progress = cycleId === null ? null : await getCycleProgress(db, cycleId);
  const sources = progress ? await channelOutcomes(db, progress.id) : null;
  const steps = progress ? await cycleStepProblems(db, progress.id) : { failed: [], partial: [] };

  let ai: ShellCycleStatus["ai"] = null;
  if (aiRun) {
    const waiting = await countUnscoredJobs(db);
    // the AI part belongs to a cycle; fall back to the newest one when the request names none
    const kind = aiRun.cycleId === null ? (progress?.kind ?? null) : ((await getCycleProgress(db, aiRun.cycleId))?.kind ?? null);
    ai = { status: aiRun.status, kind, scored: aiRun.scored, total: aiRun.scored + waiting };
  }

  return {
    cycle:
      progress && progress.status !== "skipped"
        ? { id: progress.id, kind: progress.kind, status: progress.status, runsTotal: progress.runsTotal, runsFinished: progress.runsFinished, failedSteps: steps.failed, partialSteps: steps.partial }
        : null,
    sources,
    ai,
  };
}

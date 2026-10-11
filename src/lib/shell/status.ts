/** Server side of the sidebar's cycle status: the newest cycle, its sources, running progress and the next slot. */
import { getSchedule } from "@/lib/dashboard/context";
import { nextScheduledCycle } from "@/lib/dashboard/next-cycle";
import { loadConfig } from "@/lib/config";
import { getDbNow, getLatestHeartbeat, getNavCounts, getShellCycleStatus, type Db } from "@/lib/db";
import { loadAiWorkerStatus } from "@/lib/ops/ai-worker";
import { heartbeatView } from "@/lib/settings/status";

import { shellStatusSchema, type ShellStatus } from "./status-schema";

export async function loadShellStatus(db: Db, now: Date = new Date()): Promise<ShellStatus> {
  const schedule = getSchedule();
  const aiConfig = loadConfig("ai");
  // heartbeats are stamped by the database clock, so their age is measured with it too
  const dbNow = await getDbNow(db);
  const [{ cycle, sources, ai }, counts, runnerBeat, aiWorker] = await Promise.all([
    getShellCycleStatus(db),
    getNavCounts(db, { now, timezone: schedule.timezone }),
    getLatestHeartbeat(db),
    loadAiWorkerStatus(db, { now: dbNow, aiConfig }),
  ]);
  const runner = heartbeatView(runnerBeat?.at ?? null, dbNow);
  const next = nextScheduledCycle(schedule, now);

  let progress: ShellStatus["progress"] = null;
  if (cycle?.status === "running") {
    progress = { phase: "fetch", status: "running", kind: cycle.kind, done: cycle.runsFinished, total: cycle.runsTotal };
  } else if (ai) {
    progress = { phase: "ai", status: ai.status, kind: ai.kind, done: ai.scored, total: ai.total };
  }

  const state: ShellStatus["state"] = progress ? "running" : cycle?.status === "failed" ? "failed" : "idle";
  // the badge on "Sources" counts what that page has to explain: channels that are down / behind an open circuit / failed in the newest cycle, plus the cycle itself when a step failed
  const channelAlerts = Math.max(counts.sourcesAlert, (sources?.failed ?? 0) + (sources?.circuitOpen ?? 0));
  const cycleAlert = cycle && (cycle.status === "failed" || cycle.failedSteps.length > 0 || cycle.partialSteps.some((name) => name !== "collect")) ? 1 : 0;
  return shellStatusSchema.parse({
    now: now.toISOString(),
    state,
    timezone: schedule.timezone,
    next: next ? { kind: next.kind, at: next.at.toISOString() } : null,
    cycle: cycle ? { id: cycle.id, kind: cycle.kind, status: cycle.status, failedSteps: cycle.failedSteps, partialSteps: cycle.partialSteps } : null,
    sources,
    runner: { online: runner.online, ageSeconds: runner.ageSeconds },
    aiWorker: { expected: aiConfig.execution === "host", online: aiWorker.online, ageSeconds: aiWorker.ageSeconds },
    counts: { today: counts.today, jobs: counts.jobs, pipeline: counts.pipeline, favorites: counts.favorites, sourcesAlert: channelAlerts + cycleAlert },
    progress,
  });
}

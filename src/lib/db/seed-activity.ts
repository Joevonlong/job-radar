/** Finished, fictional fixtures only. This helper never starts business work or publishes a heartbeat. */
import { eq, inArray, or, sql } from "drizzle-orm";
import { rootIdForCycle } from "@/lib/activity/ids";
import { buildQueries, buildSweepQuery } from "@/lib/channels/query";
import { loadConfig } from "@/lib/config";
import type { Executor } from "./executor";
import { activityEvents, activitySpans, controlRequests, runDeliveries } from "./schema";

const FIXED_PREFIX = "a1710000-0000-4000-8000-";
const fixedId = (value: number) => `${FIXED_PREFIX}${String(value).padStart(12, "0")}`;

/**
 * Remove every tree this seed wrote, found by its fixed ids rather than by the seeded cycles: the cycles may already be
 * gone (a truncate, a manual cleanup), and the cycle root's id is derived from a cycle id that can be reused.
 */
export async function removeSeedActivity(db: Executor, cycleIds: number[]): Promise<void> {
  const fixed = `${FIXED_PREFIX}%`;
  const cycleRoots = cycleIds.map(rootIdForCycle);
  await db.delete(activitySpans).where(or(
    sql`${activitySpans.id} in (select s.root_id from activity_spans s where s.id::text like ${fixed})`,
    sql`${activitySpans.id}::text like ${fixed}`,
    cycleRoots.length ? inArray(activitySpans.id, cycleRoots) : undefined,
  ));
  await db.delete(activityEvents).where(sql`${activityEvents.id}::text like ${fixed}`);
  await db.delete(controlRequests).where(sql`${controlRequests.payload} ->> 'activitySeed' = 'true'`);
}

export async function seedActivity(db: Executor, input: {
  cycleId: number; startedAt: Date; finishedAt: Date; jobIds: number[];
  runs: { id: number; channelId: string; status: string; fetched: number; newCount: number }[];
}): Promise<void> {
  const { cycleId, startedAt, finishedAt, jobIds, runs } = input;
  const rootId = rootIdForCycle(cycleId);
  const span = (id: string, name: string, status = "ok", parentId: string | null = null, treeRoot = id) => ({
    id, rootId: treeRoot, parentId, name, status, scope: treeRoot === rootId ? "cycle" : "system", process: "runner",
    startedAt, finishedAt, lastActivityAt: finishedAt, ...(treeRoot === rootId ? { cycleId } : {}),
  });
  // A root left behind for an earlier cycle with this (reused) id would otherwise collide; it describes a cycle that no
  // longer exists. Children and events go with it (root_id cascades).
  await db.delete(activitySpans).where(eq(activitySpans.id, rootId));
  await db.insert(activitySpans).values({ ...span(rootId, "cycle", "partial"), progressDone: 7, progressTotal: 7 });
  const steps = ["collect", "pipeline", "filter", "signals", "ai", "notify", "maintenance"];
  await db.insert(activitySpans).values(steps.map((name, index) => ({ ...span(fixedId(10 + index), `step.${name}`, name === "collect" ? "partial" : "ok", rootId, rootId), progressDone: 3, progressTotal: 3 })));
  const search = loadConfig("search");
  const queries = buildQueries(search, "manual");
  const sweep = buildSweepQuery(search, "manual");
  const querySpans = runs.filter((run) => run.status !== "skipped").map((run, index) => ({
    ...span(fixedId(100 + index), "collect.query", run.status === "failed" ? "failed" : "ok", fixedId(10), rootId),
    runId: run.id, channelId: run.channelId, queryId: index === 0 ? sweep.id : queries[index % queries.length]?.id,
  }));
  const skippedRun = runs.find((run) => run.status === "skipped");
  const skipped = [0, 1].map((index) => ({ ...span(fixedId(200 + index), "collect.query", "skipped", fixedId(10), rootId), reasonCode: "mixed",
    channelId: skippedRun?.channelId ?? null, queryId: queries[index % queries.length]?.id ?? `seed-query-${index}`, runId: index === 0 ? skippedRun?.id ?? null : null }));
  await db.insert(activitySpans).values([...querySpans, ...skipped]);
  const ledgerRun = runs.find((run) => run.status === "succeeded");
  if (ledgerRun) await db.insert(runDeliveries).values({ runId: ledgerRun.id, channelId: ledgerRun.channelId, ledger: "collect", delivered: ledgerRun.fetched, billedUnits: ledgerRun.fetched,
    distinctIds: ledgerRun.fetched, countsJson: { dispositions: { stored: ledgerRun.newCount, outside_window: ledgerRun.fetched - ledgerRun.newCount }, flags: {} } });
  const scoreId = fixedId(300);
  await db.insert(activitySpans).values({ ...span(scoreId, "ai.score", "partial", fixedId(14), rootId), progressDone: 3, progressTotal: 3 });
  const event = (id: number, spanId: string, code: string, params: Record<string, string | number> = {}, level = "info", jobId: number | null = null, treeRoot = rootId) => ({
    id: fixedId(1000 + id), rootId: treeRoot, spanId, at: finishedAt, level, code, params, jobId,
  });
  await db.insert(activityEvents).values([
    event(1, scoreId, "item.ok", {}, "info", jobIds[0] ?? null),
    event(2, scoreId, "item.failed", { error_code: "timeout" }, "error", jobIds[1] ?? null),
    event(3, scoreId, "item.failed", { error_code: "not_found" }, "error", Number.MAX_SAFE_INTEGER),
    event(4, fixedId(10), "queries_not_reached", { count: 2 }),
    event(5, fixedId(10), "parse_failed", {}, "warn"),
    ...skipped.map((query, index) => event(10 + index, query.id, "cascade_reasons", { "linkedin-guest": "budget_exceeded", "linkedin-brightdata": "circuit_open" }, "warn")),
  ]);
  // No jobId in these old, finished requests: no job page, queue, cooldown or settings trigger consumes them.
  const old = new Date(startedAt.getTime() - 365 * 24 * 60 * 60 * 1000);
  const [request, failed] = await db.insert(controlRequests).values([
    { kind: "translate_job", status: "done", payload: { activitySeed: true }, requestedAt: old, startedAt: old, finishedAt: old },
    { kind: "breakdown_job", status: "failed", payload: { activitySeed: true }, requestedAt: old, startedAt: old, finishedAt: old, result: { error: "invalid_payload" } },
  ]).returning({ id: controlRequests.id });
  if (!request || !failed) throw new Error("seed: activity requests were not created");
  await db.insert(activitySpans).values([
    { ...span(fixedId(1), "request.translate_job", "interrupted"), scope: "request", controlRequestId: request.id, jobId: jobIds[0] ?? null, reasonCode: "not_recorded" },
    { ...span(fixedId(2), "request.translate_job"), scope: "request", controlRequestId: request.id, jobId: jobIds[0] ?? null, startedAt: new Date(startedAt.getTime() + 1) },
    { ...span(fixedId(3), "request.breakdown_job", "failed"), scope: "request", controlRequestId: failed.id, reasonCode: "invalid_payload" },
    span(fixedId(4), "system.backup"), span(fixedId(5), "system.telegram_callback"),
  ]);
  await db.insert(activityEvents).values(event(20, fixedId(5), "item.ok", { action: "interested", result: "changed" }, "info", jobIds[0] ?? null, fixedId(5)));
}

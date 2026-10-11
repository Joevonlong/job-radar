import { and, asc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";

import type { Db } from "../client";
import { OPEN_CONTROL_STATUSES } from "../repos/control-requests";
import { controlRequests, scores, translations } from "../schema";

/** The AI part of a cycle while the ai-worker has not finished it (`run_ai`). */
export interface AiRunProgress {
  requestId: number;
  /** `pending`: waits for the ai-worker to take it; `running`: the worker is on it. */
  status: "pending" | "running";
  /** The cycle the AI part belongs to; null when the request names none. */
  cycleId: number | null;
  requestedAt: Date;
  startedAt: Date | null;
  /** Postings scored since the worker started (since the request was made while it still waits). */
  scored: number;
  /** Translations stored since then. */
  translated: number;
}

/**
 * The oldest `run_ai` request that is still open, with what the worker has produced since it began: the AI sub-tasks
 * report no progress of their own, so the counters are read from what they wrote (scores, translations). Null when
 * no AI part is open.
 */
export async function getOpenAiRun(db: Db): Promise<AiRunProgress | null> {
  const [request] = await db
    .select()
    .from(controlRequests)
    .where(and(eq(controlRequests.kind, "run_ai"), inArray(controlRequests.status, [...OPEN_CONTROL_STATUSES])))
    .orderBy(asc(controlRequests.id))
    .limit(1);
  if (!request || (request.status !== "pending" && request.status !== "running")) return null;

  const since = request.startedAt ?? request.requestedAt;
  const [scored] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(scores)
    .where(and(gte(scores.scoredAt, since), isNotNull(scores.score)));
  const [translated] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(translations)
    .where(gte(translations.createdAt, since));

  const payload = request.payload;
  const rawCycle = typeof payload === "object" && payload !== null && "cycleId" in payload ? (payload as { cycleId: unknown }).cycleId : null;
  return {
    requestId: request.id,
    status: request.status,
    cycleId: typeof rawCycle === "number" && Number.isInteger(rawCycle) ? rawCycle : null,
    requestedAt: request.requestedAt,
    startedAt: request.startedAt,
    scored: scored?.n ?? 0,
    translated: translated?.n ?? 0,
  };
}

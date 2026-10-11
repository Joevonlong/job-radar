/** Server side of `/api/control/requests/<id>`: one request of a trigger button, with its outcome. */
import { findManualCycleSince, getControlRequest, getCycleProgress, TEST_CONTROL_REQUEST_KINDS, type ControlRequestKind, type Db } from "@/lib/db";

import { controlRequestViewSchema, requestResultViewSchema, type ControlRequestView } from "./request-view-schema";

/** The kinds a trigger button may poll: a (channel) cycle and the tests. */
const POLLABLE: readonly ControlRequestKind[] = ["run_cycle", ...TEST_CONTROL_REQUEST_KINDS];

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

/** Null when there is no such request, or it is not one a button made. */
export async function loadControlRequestView(db: Db, id: number): Promise<ControlRequestView | null> {
  const request = await getControlRequest(db, id);
  if (!request || !POLLABLE.includes(request.kind)) return null;
  // keep only the fields the page understands; anything unexpected reads as "no detail"
  const parsed = requestResultViewSchema.safeParse(request.result ?? {});
  const result = parsed.success ? parsed.data : {};

  let cycle: ControlRequestView["cycle"] = null;
  if (request.kind === "run_cycle") {
    let cycleId = result.cycleId ?? null;
    if (cycleId === null && request.status === "running" && request.startedAt) cycleId = await findManualCycleSince(db, request.startedAt);
    const progress = cycleId === null ? null : await getCycleProgress(db, cycleId);
    if (progress) {
      cycle = { id: progress.id, status: progress.status, runsTotal: progress.runsTotal, runsFinished: progress.runsFinished, fetched: progress.fetched, newCount: progress.newCount };
    }
  }

  return controlRequestViewSchema.parse({
    id: request.id,
    kind: request.kind,
    status: request.status,
    requestedAt: request.requestedAt.toISOString(),
    startedAt: iso(request.startedAt),
    finishedAt: iso(request.finishedAt),
    result,
    cycle,
  });
}

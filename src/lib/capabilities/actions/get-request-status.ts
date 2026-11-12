import { z } from "zod";
import { loadQueueView } from "@/lib/control/queue-view";
import { findManualCycleSince, getCycleProgress } from "@/lib/db";
import { getAgentControlRequest } from "@/lib/db/repos/control-requests";
import { ToolFailure } from "@/lib/mcp/context";
import { requestStatusOutput, toRequestSummary } from "@/lib/mcp/dto/actions";
import { READ_ONLY, defineCapability } from "../types";
import { actionCaller } from "./run-action";

const cycleResult = z.object({ cycleId: z.number().int().positive().nullable().optional() });

export const get_request_status = defineCapability({
  id: "get_request_status",
  kind: "read",
  permission: "actions:run",
  input: (ctx) => z.strictObject({ request_id: z.number().int().positive().describe(ctx.text("params.requestId")) }),
  output: requestStatusOutput,
  handler: async (ctx, args) => {
    const request = await getAgentControlRequest(ctx.db, args.request_id, actionCaller(ctx));
    if (!request) throw new ToolFailure("not_found", ctx.text("errors.requestNotFound"));
    const queue = await loadQueueView(ctx.db, { ...request, payload: {} });
    let cycle = null;
    if (request.kind === "run_cycle") {
      let cycleId = cycleResult.safeParse(request.result).data?.cycleId ?? null;
      if (cycleId === null && request.status === "running" && request.startedAt) cycleId = await findManualCycleSince(ctx.db, request.startedAt);
      const progress = cycleId === null ? null : await getCycleProgress(ctx.db, cycleId);
      if (progress) cycle = { id: progress.id, status: progress.status, runs_total: progress.runsTotal, runs_finished: progress.runsFinished, fetched: progress.fetched, new: progress.newCount };
    }
    return requestStatusOutput.parse({
      request_id: request.id, status: request.status, ahead: queue?.ahead ?? null, worker_online: queue?.worker.online ?? null,
      requested_at: request.requestedAt.toISOString(), started_at: request.startedAt?.toISOString() ?? null,
      finished_at: request.finishedAt?.toISOString() ?? null, result: toRequestSummary(request.result), cycle, notices: [],
    });
  },
  count: () => 1,
  annotations: READ_ONLY,
  text: { title: "tools.get_request_status.title", description: "tools.get_request_status.description" },
});

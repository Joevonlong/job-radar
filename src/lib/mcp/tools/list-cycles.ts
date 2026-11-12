import { z } from "zod";
import { MCP_MAX_RESULTS_CAP } from "@/lib/config/schemas/mcp";
import { getCycle } from "@/lib/db";
import { listOpsCycles, listOpsRuns } from "@/lib/db/queries/ops";
import { ToolFailure, type McpContext } from "../context";
import { listCyclesOutput, toCycleDto, toRunDto } from "../dto/ops";
import { resultLimit } from "./shared";

export function listCyclesInput(ctx: Pick<McpContext, "text">) {
  return z.strictObject({ limit: z.number().int().min(1).max(MCP_MAX_RESULTS_CAP).optional().describe(ctx.text("params.limit")), cycle_id: z.number().int().safe().positive().optional().describe(ctx.text("ops.params.cycleId")) });
}
export async function listCycles(ctx: McpContext, args: z.infer<ReturnType<typeof listCyclesInput>>) {
  const limit = resultLimit(ctx, args.limit);
  const rows = await listOpsCycles(ctx.db, limit + 1);
  let expanded = null;
  if (args.cycle_id !== undefined) {
    const cycle = await getCycle(ctx.db, args.cycle_id);
    if (!cycle) throw new ToolFailure("not_found", ctx.text("ops.errors.cycleNotFound"));
    const runs = await listOpsRuns(ctx.db, cycle.id, limit + 1);
    expanded = { cycle: toCycleDto(cycle), runs: runs.slice(0, limit).map(toRunDto), returned: Math.min(runs.length, limit), truncated: runs.length > limit };
  }
  return listCyclesOutput.parse({ notices: [], returned: Math.min(rows.length, limit), truncated: rows.length > limit, cycles: rows.slice(0, limit).map(toCycleDto), expanded });
}

import { z } from "zod";
import { actionOutput } from "@/lib/mcp/dto/actions";
import { ADDS_ONLY, defineCapability } from "../types";
import { actionAvailability } from "./availability";
import { runAction, controlOutcome } from "./run-action";
import { requestRunCycle } from "@/lib/control/service";
import { runCyclePayloadSchema } from "@/lib/control/types";

export const run_collection = defineCapability({
  id: "run_collection",
  kind: "trigger",
  permission: "actions:run",
  input: (ctx) => z.strictObject({
    channel_ids: runCyclePayloadSchema.shape.channelIds.describe(ctx.text("params.channelIds")),
    backfill_hours: runCyclePayloadSchema.shape.backfillHours.describe(ctx.text("params.backfillHours")),
  }),
  output: actionOutput,
  handler: (ctx, args) => runAction(ctx, "run_collection", async (db, caller) => controlOutcome(await requestRunCycle({ channelIds: args.channel_ids, backfillHours: args.backfill_hours }, { db, caller }))),
  count: () => 1,
  annotations: ADDS_ONLY,
  availability: actionAvailability("run_collection"),
  text: { title: "tools.run_collection.title", description: "tools.run_collection.description" },
});

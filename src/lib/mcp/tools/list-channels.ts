import { z } from "zod";
import { MCP_MAX_RESULTS_CAP } from "@/lib/config/schemas/mcp";
import { loadSourcesView } from "@/lib/sources/load";
import type { McpContext } from "../context";
import { listChannelsOutput, toChannelDto } from "../dto/ops";
import { resultLimit } from "./shared";

export function listChannelsInput(ctx: Pick<McpContext, "text">) {
  return z.strictObject({ limit: z.number().int().min(1).max(MCP_MAX_RESULTS_CAP).optional().describe(ctx.text("params.limit")), offset: z.number().int().safe().nonnegative().optional().describe(ctx.text("ops.params.offset")) });
}
export async function listChannels(ctx: McpContext, args: z.infer<ReturnType<typeof listChannelsInput>>) {
  const view = await loadSourcesView(undefined, ctx.db);
  const limit = resultLimit(ctx, args.limit);
  const offset = args.offset ?? 0;
  const channels = view.cards.slice(offset, offset + limit).map(toChannelDto);
  return listChannelsOutput.parse({ notices: [], month: view.month, total: view.cards.length, returned: channels.length, truncated: offset + channels.length < view.cards.length, channels });
}

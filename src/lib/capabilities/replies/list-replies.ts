import { z } from "zod";
import { REPLY_CATEGORIES } from "@/lib/config/schemas/replies";
import { listReplyMetadata } from "@/lib/db/queries/replies";
import { listRepliesOutput, listRepliesOutputFor, replyStateSchema } from "@/lib/mcp/dto/replies";
import { readTextCleaner } from "@/lib/mcp/read-guard";
import { readTraps, resultLimit, truncationNotice } from "@/lib/mcp/tools/shared";
import { defineCapability, READ_ONLY } from "../types";

export const list_replies = defineCapability({
  id: "list_replies",
  kind: "read",
  permission: "replies:read",
  input: (ctx) => z.strictObject({
    state: replyStateSchema.optional().describe(ctx.text("params.replyState")),
    category: z.enum(REPLY_CATEGORIES).optional().describe(ctx.text("params.replyCategory")),
    since: z.iso.datetime({ offset: true }).optional().describe(ctx.text("params.replySince")),
    limit: z.number().int().positive().optional().describe(ctx.text("params.limit")),
  }),
  output: listRepliesOutput,
  outputFor: listRepliesOutputFor,
  handler: async (ctx, args) => {
    const limit = resultLimit(ctx, args.limit);
    const withStatus = ctx.permissions?.has("tracking:read") === true;
    const { rows, total } = await listReplyMetadata(ctx.db, {
      state: args.state, category: args.category, since: args.since ? new Date(args.since) : undefined, limit, includeApplicationStatus: withStatus,
    });
    const clean = readTextCleaner(readTraps(ctx), ctx.text("notice.redacted"));
    const truncated = rows.length < total;
    return {
      notices: [ctx.text("notice.thirdParty"), ...(truncated ? [truncationNotice(ctx, rows.length, total, limit)] : [])],
      replies: rows.map((row) => ({
        id: row.id,
        receivedAt: row.receivedAt.toISOString(),
        category: row.userCategory ?? row.category,
        match: row.match,
        state: row.state,
        jobId: row.jobId,
        company: row.company === null ? null : clean(row.company),
        title: row.title === null ? null : clean(row.title),
        ...(withStatus ? { applicationStatus: row.applicationStatus ?? null } : {}),
      })),
      total,
      returned: rows.length,
      truncated,
    };
  },
  count: (output) => output.returned,
  annotations: READ_ONLY,
  availability: {
    available: (ctx) => ctx.features?.repliesEnabled() === true,
    category: "disabled",
    message: "errors.repliesDisabled",
  },
  text: { title: "tools.list_replies.title", description: "tools.list_replies.description" },
});

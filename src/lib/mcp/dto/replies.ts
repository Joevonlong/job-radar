import { z } from "zod";
import { REPLY_CATEGORIES } from "@/lib/config/schemas/replies";

export const replyStateSchema = z.enum(["pending", "applied", "dismissed", "reverted", "superseded", "info"]);
export const listRepliesOutput = z.strictObject({
  notices: z.array(z.string()),
  replies: z.array(z.strictObject({
    id: z.number().int(),
    receivedAt: z.string(),
    category: z.enum(REPLY_CATEGORIES),
    match: z.enum(["matched", "ambiguous", "unmatched"]),
    state: replyStateSchema,
    jobId: z.number().nullable(),
    company: z.string().nullable(),
    title: z.string().nullable(),
    applicationStatus: z.string().nullable(),
  })),
  total: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

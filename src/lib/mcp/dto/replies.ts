import { z } from "zod";
import type { Permission } from "@/lib/agent-access/permissions";
import { REPLY_CATEGORIES } from "@/lib/config/schemas/replies";

export const replyStateSchema = z.enum(["pending", "applied", "dismissed", "reverted", "superseded", "info"]);
const replyDto = z.strictObject({
  id: z.number().int(),
  receivedAt: z.string(),
  category: z.enum(REPLY_CATEGORIES),
  match: z.enum(["matched", "ambiguous", "unmatched"]),
  state: replyStateSchema,
  jobId: z.number().nullable(),
  company: z.string().nullable(),
  title: z.string().nullable(),
  applicationStatus: z.string().nullable(),
});
export const listRepliesOutput = z.strictObject({
  notices: z.array(z.string()),
  replies: z.array(replyDto.partial({ applicationStatus: true })),
  total: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export function listRepliesOutputFor(permissions: ReadonlySet<Permission>): z.ZodType<z.infer<typeof listRepliesOutput>> {
  const reply = permissions.has("tracking:read") ? replyDto : replyDto.omit({ applicationStatus: true });
  return listRepliesOutput.extend({ replies: z.array(reply) });
}

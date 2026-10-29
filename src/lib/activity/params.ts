import { z } from "zod";

export const shortIdSchema = z.string().regex(/^[a-z0-9_.:-]{1,64}$/);
export const activityParamsSchema = z.record(shortIdSchema, z.union([z.number().int().safe(), z.boolean(), shortIdSchema]))
  .refine((value) => Object.keys(value).length <= 12, "at most twelve parameters");
export type ActivityParams = z.infer<typeof activityParamsSchema>;
export const businessIdSchema = z.number().int().safe().positive();
export const spanLinksSchema = z.strictObject({
  cycleId: businessIdSchema.optional(), controlRequestId: businessIdSchema.optional(), runId: businessIdSchema.optional(), jobId: businessIdSchema.optional(),
  channelId: shortIdSchema.optional(), queryId: shortIdSchema.optional(),
});

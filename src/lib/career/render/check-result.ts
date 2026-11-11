import { z } from "zod";

export const findingSchema = z.object({
  code: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  severity: z.enum(["error", "warn", "info", "ok"]),
  path: z.string().optional(),
});
export type DocumentFinding = z.infer<typeof findingSchema>;
export const pageCheckSchema = z.object({
  pages: z.number().int().positive().nullable(),
  budget: z.object({ pages: z.number().int().positive(), exceeded: z.boolean() }).nullable(),
  findings: z.array(findingSchema),
  code: z.string().optional(),
});
export type PageCheck = z.infer<typeof pageCheckSchema>;

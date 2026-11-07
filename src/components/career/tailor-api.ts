import { z } from "zod";
import { documentSchema } from "@/lib/career/schema/document";
import { proposalsSchema } from "@/lib/career/tailor/proposal-schema";
import { controlQueueViewSchema } from "@/lib/control/request-view-schema";

export const outboundPreviewSchema = z.object({
  blocks: z.array(z.object({ id: z.string(), text: z.string() })),
  jd: z.string().nullable(),
  jd_truncated: z.boolean(),
  hash: z.string(),
});
export type OutboundPreview = z.infer<typeof outboundPreviewSchema>;

const failureSchema = z.object({ ok: z.literal(false), error: z.string() });

export const preparedSchema = z.union([
  z.object({ ok: z.literal(true), existing: z.literal(true), doc_id: z.string() }),
  outboundPreviewSchema.extend({ ok: z.literal(true), existing: z.literal(false), doc_id: z.string(), hasProposals: z.boolean() }),
  failureSchema,
]);

export const queuedSchema = z.union([
  z.object({ ok: z.literal(true), state: z.literal("queued"), requestId: z.number().int().positive(), replacesProposals: z.boolean().optional() }),
  outboundPreviewSchema.extend({ ok: z.literal(false), error: z.literal("review_again") }),
  failureSchema,
]);

export const tailorStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("waiting"), requestId: z.number().int().positive(), stage: z.enum(["pending", "running"]), queue: controlQueueViewSchema.nullable() }),
  z.object({ state: z.literal("failed"), error: z.string() }),
  z.object({ state: z.literal("done"), proposals: z.number(), dropped: z.number(), flagged: z.number() }),
  z.object({ state: z.literal("missing") }),
]);
export type TailorStatus = z.infer<typeof tailorStatusSchema>;

export const proposalsReplySchema = z.union([
  z.object({ ok: z.literal(true), proposals: proposalsSchema.nullable(), document_changed: z.boolean() }),
  failureSchema,
]);

export const actionReplySchema = z.union([
  z.object({ ok: z.literal(true), document: documentSchema, baseHash: z.string(), state: z.enum(["applied", "target_gone", "missing"]).optional() }),
  z.object({ ok: z.literal(true) }),
  failureSchema,
]);
export type ActionReply = z.infer<typeof actionReplySchema>;

export async function callTailor<T extends z.ZodType>(schema: T, url: string, body?: unknown): Promise<z.infer<T> | { ok: false; error: string }> {
  try {
    const response = await fetch(url, body === undefined
      ? { cache: "no-store" }
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const parsed = schema.safeParse(await response.json());
    return parsed.success ? parsed.data : { ok: false, error: "unavailable" };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

export function tailorAction(body: Record<string, unknown>) {
  return callTailor(actionReplySchema, "/api/career/tailor/actions", body);
}

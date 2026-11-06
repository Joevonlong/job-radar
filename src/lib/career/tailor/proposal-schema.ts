import { z } from "zod";
import { claimSchema, documentIdSchema } from "../schema/document";

const id = z.string().max(100).min(1);
export const proposalTargetSchema = z.union([
  z.strictObject({ text: id }),
  z.strictObject({ entry: id, field: z.enum(["stack", "skills"]).optional() }),
  z.strictObject({ list: id }),
  z.strictObject({ letter: z.enum(["recipient", "subject", "salutation", "closing", "place", "date"]) }),
]);
export const proposalInputSchema = z.strictObject({
  action: z.enum(["rewrite", "shorten", "drop", "include", "add", "reorder"]),
  target: proposalTargetSchema,
  text: z.string().max(20000).optional(),
  after: id.nullable().optional(),
  order: z.array(id).max(1000).optional(),
  support: z.array(z.union([z.strictObject({ quote: z.string().min(1).max(20000) }), z.strictObject({ entry: id })])).max(100).default([]),
  rationale: z.string().max(20000).default(""),
});
export const proposalSchema = proposalInputSchema.extend({
  id: z.string().regex(/^prp_[a-z2-7]{10}$/), claims: z.array(claimSchema).max(1000),
});
export const proposalsSchema = z.strictObject({
  schema_version: z.literal(1), doc_id: documentIdSchema, doc_hash: z.string().regex(/^[a-f0-9]{64}$/),
  request_id: z.number().int().positive(), items: z.array(proposalSchema).max(1000),
});
export const tailorOutputSchema = z.strictObject({ items: z.array(proposalInputSchema.extend({ action: z.string().min(1).max(40) })).max(1000) });
export type ProposalInput = z.infer<typeof proposalInputSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type Proposals = z.infer<typeof proposalsSchema>;

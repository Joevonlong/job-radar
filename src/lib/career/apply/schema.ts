/**
 * The shapes of the apply request and response, without server dependencies: the route validates requests with them and
 * the career page validates the responses it receives.
 */
import { z } from "zod";

import { storySchema } from "@/lib/config/schemas/stories";

export const ME_FIELDS = ["languages", "skills", "years_experience", "summary"] as const;

const idList = z.array(z.string().max(200)).max(5000);
export const applySelectionSchema = z.strictObject({
  me: z.strictObject(Object.fromEntries(ME_FIELDS.map((field) => [field, z.boolean()])) as Record<(typeof ME_FIELDS)[number], z.ZodBoolean>),
  stories: z.strictObject({ write: idList, remove: idList }),
});

export const applyBasesSchema = z.strictObject({
  profile: z.string().max(200),
  me: z.string().max(200),
  stories: z.string().max(200),
  staleCount: z.number().int().min(0),
});

const meFieldChangeSchema = z.object({
  field: z.enum(ME_FIELDS),
  current: z.unknown(),
  proposed: z.unknown(),
  changed: z.boolean(),
  defaultSelected: z.boolean(),
  truncated: z.boolean(),
});

const storyChangeSchema = z.object({
  id: z.string(),
  kind: z.enum(["new", "changed", "unchanged", "removed"]),
  current: storySchema.nullable(),
  proposed: storySchema.nullable(),
  defaultSelected: z.boolean(),
  truncated: z.boolean(),
});

export const applyPreviewSchema = z.object({
  me: z.object({ fields: z.array(meFieldChangeSchema), languagesNotApplied: z.array(z.string()) }),
  stories: z.object({ changes: z.array(storyChangeSchema), notApplied: z.array(z.string()) }),
  selection: applySelectionSchema,
  staleCount: z.number().int().min(0),
  noChanges: z.boolean(),
  tooMany: z.boolean(),
  maxItems: z.number().int(),
  bases: applyBasesSchema,
});

const FILE_OUTCOMES = ["written", "unchanged", "failed", "snapshot_failed", "stale"] as const;
export const applyConfirmResultSchema = z.union([
  z.object({ status: z.literal("error"), code: z.enum(["me_required", "profile_empty", "too_many"]) }),
  z.object({ status: z.literal("stale"), preview: applyPreviewSchema }),
  z.object({
    status: z.literal("applied"),
    me: z.enum(FILE_OUTCOMES),
    stories: z.enum(FILE_OUTCOMES),
    staleMarked: z.number().int().nullable(),
    staleExpected: z.number().int(),
  }),
]);

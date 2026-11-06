import { z } from "zod";

/** Why the upload route refused a request. */
export const STORY_EXTRACT_ROUTE_ERRORS = ["invalid", "too_large", "bad_type", "unreadable", "too_complex", "no_text", "disabled", "busy", "too_many", "config_error", "unavailable", "review_again", "too_long", "scrub_mismatch", "preview_required"] as const;
export type StoryExtractRouteError = (typeof STORY_EXTRACT_ROUTE_ERRORS)[number];

/** The answer of `POST /api/me/story-extract`: a boundary, so the browser parses it too. */
export const storyExtractResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), requestId: z.number().int().positive(), truncated: z.boolean() }),
  z.object({ ok: z.literal(false), error: z.enum(STORY_EXTRACT_ROUTE_ERRORS), text: z.string().optional(), highlights: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), kind: z.string() })).optional() }),
]);
export type StoryExtractResponse = z.infer<typeof storyExtractResponseSchema>;

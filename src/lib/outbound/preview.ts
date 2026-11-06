import { z } from "zod";

export const preparedTextSchema = z.object({
  ok: z.literal(true), text: z.string(), candidates: z.object({ name: z.string().nullable(), address: z.string().nullable() }),
  removed: z.number().int().nonnegative(), chars: z.number().int().nonnegative(), truncated: z.boolean(),
  highlights: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), kind: z.string() })),
});
export type PreparedText = z.infer<typeof preparedTextSchema>;
export const outboundFailureSchema = z.object({ ok: z.literal(false), error: z.string(), text: z.string().optional() });

/** Keep untouched highlights aligned when the editable text changes. */
export function editedPreview(preview: PreparedText, text: string): PreparedText {
  let start = 0;
  while (start < Math.min(preview.text.length, text.length) && preview.text[start] === text[start]) start++;
  let end = preview.text.length;
  let nextEnd = text.length;
  while (end > start && nextEnd > start && preview.text[end - 1] === text[nextEnd - 1]) { end--; nextEnd--; }
  const shift = text.length - preview.text.length;
  const highlights = preview.highlights.flatMap((span) => span.end <= start ? [span] : span.start >= end ? [{ ...span, start: span.start + shift, end: span.end + shift }] : []);
  return { ...preview, text, chars: text.length, highlights };
}

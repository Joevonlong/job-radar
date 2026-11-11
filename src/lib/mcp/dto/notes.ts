/** Notes require their own effective permission and always pass through the text cleaner. */
import { z } from "zod";

export const notesBlockDto = z.strictObject({
  application_notes: z.string().nullable(),
  /** `from` and `to` only when tracking permission is effective as well; otherwise the note and its time. */
  event_notes: z.array(z.strictObject({ at: z.iso.datetime({ offset: true }), from: z.string().nullable().optional(), to: z.string().optional(), note: z.string() })),
  favorite_note: z.string().nullable(),
});

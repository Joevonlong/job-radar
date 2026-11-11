import type { z } from "zod";

import type { McpContext } from "@/lib/mcp/context";
import { notesBlockDto } from "@/lib/mcp/dto/notes";

import type { JobBlockSource } from "./source";

/** A status change is tracking data: an event note carries its from and to status only when tracking permission is effective too. */
export async function loadNotes(ctx: McpContext, { detail, clean }: JobBlockSource): Promise<z.infer<typeof notesBlockDto>> {
  const tracking = ctx.permissions?.has("tracking:read") ?? false;
  return {
    application_notes: detail.application?.notesMd === null || detail.application?.notesMd === undefined ? null : clean(detail.application.notesMd),
    event_notes: detail.applicationEvents.flatMap((event) => event.note === null ? [] : [{ at: event.at.toISOString(), ...(tracking ? { from: event.fromStatus, to: event.toStatus } : {}), note: clean(event.note) }]),
    favorite_note: detail.favorite?.note === null || detail.favorite?.note === undefined ? null : clean(detail.favorite.note),
  };
}

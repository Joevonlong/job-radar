import type { z } from "zod";

import type { McpContext } from "@/lib/mcp/context";
import { notesBlockDto } from "@/lib/mcp/dto/notes";

import type { JobBlockSource } from "./source";

export async function loadNotes(_ctx: McpContext, { detail, clean }: JobBlockSource): Promise<z.infer<typeof notesBlockDto>> {
  return {
    application_notes: detail.application?.notesMd === null || detail.application?.notesMd === undefined ? null : clean(detail.application.notesMd),
    event_notes: detail.applicationEvents.flatMap((event) => event.note === null ? [] : [{ at: event.at.toISOString(), from: event.fromStatus, to: event.toStatus, note: clean(event.note) }]),
    favorite_note: detail.favorite?.note === null || detail.favorite?.note === undefined ? null : clean(detail.favorite.note),
  };
}

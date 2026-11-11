import { z } from "zod";
import type { FieldBlock } from "@/lib/capabilities/blocks";
import type { Application, ApplicationEvent } from "@/lib/db/repos/applications";
import type { CleanText } from "./dto/shared";

export const applicationNotesDto = z.strictObject({ application_notes: z.string().nullable() });
export const applicationDetailNotesDto = applicationNotesDto.extend({ event_notes: z.array(z.strictObject({ at: z.string(), from: z.string().nullable(), to: z.string(), note: z.string() })) });
export const favoriteNotesDto = z.strictObject({ favorite_note: z.string().nullable() });
export interface ApplicationNotesSource { application: Application; events: readonly ApplicationEvent[]; clean: CleanText }
export const applicationNotesBlocks: readonly FieldBlock<ApplicationNotesSource>[] = [{ key: "notes", permission: "notes:read", schema: applicationNotesDto, onRequest: false, load: async (_ctx, { application, clean }) => ({ application_notes: application.notesMd === null ? null : clean(application.notesMd) }) }];
export const applicationDetailNotesBlocks: readonly FieldBlock<ApplicationNotesSource>[] = [{ key: "notes", permission: "notes:read", schema: applicationDetailNotesDto, onRequest: false, load: async (_ctx, { application, events, clean }) => ({ application_notes: application.notesMd === null ? null : clean(application.notesMd), event_notes: events.flatMap((event) => event.note === null ? [] : [{ at: event.at.toISOString(), from: event.fromStatus, to: event.toStatus, note: clean(event.note) }]) }) }];
export const favoriteNotesBlocks: readonly FieldBlock<{ note: string | null; clean: CleanText }>[] = [{ key: "notes", permission: "notes:read", schema: favoriteNotesDto, onRequest: false, load: async (_ctx, { note, clean }) => ({ favorite_note: note === null ? null : clean(note) }) }];

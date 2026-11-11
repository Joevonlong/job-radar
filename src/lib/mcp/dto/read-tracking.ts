import { z } from "zod";
import type { Permission } from "@/lib/agent-access/permissions";
import { blockShape } from "@/lib/capabilities/blocks";
import { applicationDetailNotesBlocks, applicationDetailNotesDto, favoriteNotesBlocks, favoriteNotesDto } from "../tracking-blocks";
import { trackingBlockDto } from "./job-tracking";
import { notices } from "./shared";
import { readJobDto, pageFields } from "./read-jobs";

export const getApplicationOutput = z.strictObject({ notices, ...pageFields, job_id: z.number().int(), title: z.string().nullable(), company: z.string().nullable(), text_withheld: z.string().nullable(), tracking: trackingBlockDto, notes: applicationDetailNotesDto.optional() });
export const getApplicationOutputFor = (permissions: ReadonlySet<Permission>): z.ZodType<z.infer<typeof getApplicationOutput>> => z.strictObject({ ...getApplicationOutput.omit({ notes: true }).shape, ...blockShape(applicationDetailNotesBlocks, permissions) });
export const favoriteItemDto = z.strictObject({ job: readJobDto, since: z.string(), notes: favoriteNotesDto.optional() });
export const listFavoritesOutput = z.strictObject({ notices, ...pageFields, favorites: z.array(favoriteItemDto) });
export const listFavoritesOutputFor = (permissions: ReadonlySet<Permission>): z.ZodType<z.infer<typeof listFavoritesOutput>> => listFavoritesOutput.extend({ favorites: z.array(z.strictObject({ ...favoriteItemDto.omit({ notes: true }).shape, ...blockShape(favoriteNotesBlocks, permissions) })) });

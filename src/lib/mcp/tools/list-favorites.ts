import { z } from "zod";
import { loadBlocks } from "@/lib/capabilities/blocks";
import { MCP_MAX_RESULTS_CAP } from "@/lib/config/schemas/mcp";
import { listFavoriteJobs } from "@/lib/db/queries/favorites";
import type { McpContext } from "../context";
import { listFavoritesOutputFor } from "../dto/read-tracking";
import { readTextCleaner } from "../read-guard";
import { favoriteNotesBlocks } from "../tracking-blocks";
import { limitReadOutput, readCards, readNotices } from "./read-shared";
import { readTraps, resultLimit } from "./shared";

export function listFavoritesInput(ctx: Pick<McpContext, "text">) {
  return z.strictObject({ sort: z.enum(["starred", "rank"]).optional().describe(ctx.text("params.favoriteSort")), limit: z.number().int().min(1).max(MCP_MAX_RESULTS_CAP).optional().describe(ctx.text("params.limit")) });
}
export async function listFavorites(ctx: McpContext, args: z.infer<ReturnType<typeof listFavoritesInput>>) {
  const cards = await listFavoriteJobs(ctx.db, { sort: args.sort ?? "starred", visa: false, ghost: false });
  const limit = resultLimit(ctx, args.limit);
  const selected = cards.slice(0, limit);
  const jobs = await readCards(ctx, selected);
  const clean = readTextCleaner(readTraps(ctx), ctx.text("notice.redacted"));
  const favorites = await Promise.all(selected.map(async (card, index) => ({ job: jobs[index]!, since: card.favorite!.createdAt.toISOString(), ...await loadBlocks(favoriteNotesBlocks, ctx, { note: card.favorite?.note ?? null, clean }, undefined) })));
  return limitReadOutput(ctx, listFavoritesOutputFor(ctx.permissions ?? new Set()), { notices: readNotices(ctx, favorites.length, cards.length, limit, jobs.some((job) => job.text_withheld !== null)), total: cards.length, returned: favorites.length, truncated: cards.length > favorites.length, favorites }, limit);
}

import { z } from "zod";
import { loadBlocks } from "@/lib/capabilities/blocks";
import { MCP_MAX_RESULTS_CAP } from "@/lib/config/schemas/mcp";
import { listFavoriteJobs } from "@/lib/db/queries/favorites";
import type { JobCard } from "@/lib/db/queries/types";
import type { McpContext } from "../context";
import { toReadJobDto } from "../dto/read-jobs";
import { listFavoritesOutputFor } from "../dto/read-tracking";
import { readTextCleaner } from "../read-guard";
import { favoriteNotesBlocks } from "../tracking-blocks";
import { limitReadOutput, readNotices } from "./read-shared";
import { readTraps, resultLimit } from "./shared";

export function listFavoritesInput(ctx: Pick<McpContext, "text">) {
  return z.strictObject({ sort: z.enum(["starred", "rank"]).optional().describe(ctx.text("params.favoriteSort")), limit: z.number().int().min(1).max(MCP_MAX_RESULTS_CAP).optional().describe(ctx.text("params.limit")) });
}
export async function listFavorites(ctx: McpContext, args: z.infer<ReturnType<typeof listFavoritesInput>>) {
  const cards = await listFavoriteJobs(ctx.db, { sort: args.sort ?? "starred", visa: false, ghost: false });
  const limit = resultLimit(ctx, args.limit);
  return assembleFavorites(ctx, cards.slice(0, limit), { total: cards.length, limit });
}

export async function assembleFavorites(ctx: McpContext, cards: readonly JobCard[], options: { total: number; limit: number; include?: readonly string[] }) {
  const { total, limit, include } = options;
  const clean = readTextCleaner(readTraps(ctx), ctx.text("notice.redacted"));
  const blocks = include === undefined ? favoriteNotesBlocks : favoriteNotesBlocks.filter(({ key }) => include.includes(key));
  const favorites = await Promise.all(cards.map(async (card) => ({
    job: toReadJobDto(card, clean), since: card.favorite!.createdAt.toISOString(),
    ...await loadBlocks(blocks, ctx, { note: card.favorite?.note ?? null, clean }, include),
  })));
  return limitReadOutput(ctx, listFavoritesOutputFor(ctx.permissions ?? new Set()), {
    notices: readNotices(ctx, favorites.length, total, limit, favorites.some(({ job }) => job.text_withheld !== null)),
    total, returned: favorites.length, truncated: total > favorites.length, favorites,
  }, limit, ["favorites"]);
}

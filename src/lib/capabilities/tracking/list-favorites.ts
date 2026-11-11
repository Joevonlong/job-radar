import { listFavoritesOutput, listFavoritesOutputFor } from "@/lib/mcp/dto/read-tracking";
import { blockList } from "../blocks";
import { favoriteNotesBlocks } from "@/lib/mcp/tracking-blocks";
import { listFavorites, listFavoritesInput } from "@/lib/mcp/tools/list-favorites";
import { defineCapability, READ_ONLY } from "../types";

export const list_favorites = defineCapability({
  id: "list_favorites", kind: "read", permission: "tracking:read",
  input: listFavoritesInput, output: listFavoritesOutput, handler: listFavorites,
  blocks: blockList(favoriteNotesBlocks),
  outputFor: listFavoritesOutputFor,
  count: (output) => output.returned, annotations: READ_ONLY,
  text: { title: "tools.list_favorites.title", description: "tools.list_favorites.description" },
});

import { z } from "zod";

import type { Permission } from "@/lib/agent-access/permissions";
import type { McpConfig } from "@/lib/config/schemas/mcp";
import { listFavoriteJobs } from "@/lib/db/queries/favorites";
import { listSyncTrackingKeys } from "@/lib/db/repos/agent-change-keys";
import { SYNC_BLOCKS, type SyncBlock } from "@/lib/db/sync-sources";
import type { McpContext } from "@/lib/mcp/context";
import { listApplicationChangesOutput, listApplicationChangesOutputFor, type ListApplicationChangesOutput } from "@/lib/mcp/dto/sync";
import { assembleApplications } from "@/lib/mcp/tools/get-application";
import { assembleFavorites } from "@/lib/mcp/tools/list-favorites";
import { resultLimit } from "@/lib/mcp/tools/shared";
import { applicationDetailNotesBlocks, favoriteNotesBlocks } from "@/lib/mcp/tracking-blocks";

import { defineCapability, READ_ONLY } from "../types";
import { readSyncBatch, syncInput, type PageEntity } from "./read";
import { syncSelection } from "./scope";

const permission = "tracking:read";
const tool = "list_application_changes";
const trackingBlocks = (Object.keys(SYNC_BLOCKS) as SyncBlock[]).filter((block) => SYNC_BLOCKS[block].entity !== "job");
const defaultBlocks = new Set([
  "app", "fav",
  ...applicationDetailNotesBlocks.filter(({ onRequest }) => !onRequest).map(({ key }) => `app.${key}`),
  ...favoriteNotesBlocks.filter(({ onRequest }) => !onRequest).map(({ key }) => `fav.${key}`),
]);

function listApplicationChangesInput(ctx: Pick<McpContext, "text">, advertised?: McpConfig) {
  const blocks = z.array(z.enum(trackingBlocks)).min(1, { error: ctx.text("sync.errors.emptyBlocks") });
  return syncInput(ctx, blocks, ctx.text("sync.params.applicationBlocks"), advertised);
}

export function applicationSyncSelection(permissions: ReadonlySet<Permission>, blocks?: readonly SyncBlock[]) {
  const selected = [...(blocks ?? trackingBlocks.filter((block) => defaultBlocks.has(block) && permissions.has(SYNC_BLOCKS[block].permission)))];
  if (selected.includes("app.notes")) selected.push("app");
  if (selected.includes("fav.notes")) selected.push("fav");
  return syncSelection({
    tool, permission, kinds: ["application", "favorite"], permissions,
    blocks: selected,
  });
}

async function listApplicationChanges(ctx: McpContext, args: z.infer<ReturnType<typeof listApplicationChangesInput>>): Promise<ListApplicationChangesOutput> {
  const selection = applicationSyncSelection(ctx.permissions ?? new Set(), args.blocks);
  return readSyncBatch(ctx, args, selection, listSyncTrackingKeys,
    (scoped, entities) => assembleChanges(scoped, entities, selection.scope.blocks));
}

async function assembleChanges(ctx: McpContext, entities: readonly PageEntity[], blocks: readonly SyncBlock[]) {
  const limit = resultLimit(ctx, undefined);
  const idsOf = (kind: "application" | "favorite") => entities.filter((entity) => entity.kind === kind).map(({ jobId }) => jobId);
  const selected = (prefix: string) => blocks.flatMap((block) => block.startsWith(prefix) ? [block.slice(prefix.length)] : []);

  const applications = await assembleApplications(ctx, idsOf("application"), limit, selected("app."));
  const cards = await listFavoriteJobs(ctx.db, { jobIds: idsOf("favorite"), sort: "starred", visa: false, ghost: false });
  const page = cards.length === 0 ? null : await assembleFavorites(ctx, cards, { total: cards.length, limit, include: selected("fav.") });
  const favorites = new Map(page?.favorites.map((favorite) => [favorite.job.id, favorite]));
  const notices = new Set(page?.notices);
  const items: ListApplicationChangesOutput["items"] = [];

  for (const { jobId, kind, removed, changedAt } of entities) {
    const fields = { job_id: jobId, changed_at: changedAt?.toISOString() ?? null };
    if (kind === "application") {
      const current = applications.get(jobId);
      if (current) {
        const { notices: itemNotices, ...application } = current;
        for (const notice of itemNotices) notices.add(notice);
        items.push({ ...fields, kind, removed: false, application });
      } else if (removed) {
        items.push({ ...fields, kind, removed: true, application: null });
      }
    } else if (kind === "favorite") {
      const favorite = favorites.get(jobId);
      if (favorite) items.push({ ...fields, kind, removed: false, favorite });
      else if (removed) items.push({ ...fields, kind, removed: true, favorite: null });
    }
  }
  return { items, notices: [...notices] };
}

export const list_application_changes = defineCapability({
  id: tool,
  kind: "read",
  permission,
  input: listApplicationChangesInput,
  output: listApplicationChangesOutput,
  outputFor: listApplicationChangesOutputFor,
  handler: listApplicationChanges,
  count: (output) => output.items.length,
  annotations: READ_ONLY,
  text: { title: "tools.list_application_changes.title", description: "tools.list_application_changes.description" },
});

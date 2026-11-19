import { randomUUID } from "node:crypto";
import { z } from "zod";

import { syncBatchSize, type McpConfig } from "@/lib/config/schemas/mcp";
import type { Executor } from "@/lib/db/executor";
import { expandAgentChangeKeys } from "@/lib/db/repos/agent-change-keys";
import { AgentChangesPruned, checkAgentChangeRetention, scanAgentChangePage } from "@/lib/db/repos/agent-change-page";
import { AgentSyncUnavailable, countHeldAgentChanges, readAgentChangeRows, withAgentChangeSnapshot, type AgentChangeSnapshot } from "@/lib/db/repos/agent-changes";
import type { SyncEntityKey } from "@/lib/db/sync-position";
import { SYNC_BLOCKS, type SyncBlock } from "@/lib/db/sync-sources";
import { ToolFailure, type McpContext } from "@/lib/mcp/context";
import { jobBlockSettings } from "@/lib/mcp/job-blocks/settings";
import { compileFamilies } from "@/lib/salary/families";

import { decodeSyncCursor, encodeSyncCursor, SyncCursorError, type SyncCursor } from "./cursor";
import type { syncSelection } from "./scope";

type Progress = Pick<Extract<SyncCursor, { phase: "snapshot" }>, "phase" | "position"> |
  Pick<Extract<SyncCursor, { phase: "changes" }>, "phase" | "position">;

type Selection = ReturnType<typeof syncSelection>;
type BlockSettings = ReturnType<typeof jobBlockSettings>;
type SnapshotKeys = (tx: Executor, after: SyncEntityKey | null, limit: number) => Promise<SyncEntityKey[]>;
export type PageEntity = SyncEntityKey & { changedAt: Date | null; removed: boolean };

interface SyncPage {
  entities: PageEntity[];
  has_more: boolean;
  held_back: number | null;
  next: Progress;
}

export function syncInput<Block extends SyncBlock>(ctx: Pick<McpContext, "text">, blocks: readonly Block[], blockDescription: string, advertised?: McpConfig) {
  const max = advertised?.sync.max_batch;
  return z.strictObject({
    cursor: z.string({ error: ctx.text("sync.errors.invalidCursor") }).nullish().describe(ctx.text("sync.params.cursor")),
    limit: (max === undefined ? syncBatchSize.optional() : syncBatchSize.max(max).default(max)).describe(ctx.text("sync.params.limit")),
    blocks: z.array(z.enum(blocks)).optional().describe(blockDescription),
  });
}

function syncLimit(ctx: McpContext, requested: number | undefined): number {
  const max = ctx.settings.sync.max_batch;
  const parsed = syncBatchSize.max(max).safeParse(requested ?? max);
  if (!parsed.success) throw new ToolFailure("invalid_input", ctx.text("sync.errors.limit", { max }));
  return parsed.data;
}

function checkBlockPermissions(ctx: McpContext, selection: Selection): void {
  const [block] = selection.unpermitted;
  if (block) throw new ToolFailure("invalid_input", ctx.text("sync.errors.block", { block, permission: SYNC_BLOCKS[block].permission }));
}

async function readSyncPage(
  tx: Executor, state: AgentChangeSnapshot, cursor: Progress, selection: Selection, limit: number,
  snapshotKeys: SnapshotKeys, settings: BlockSettings,
): Promise<SyncPage> {
  if (cursor.phase === "snapshot") {
    const keys = await snapshotKeys(tx, cursor.position.after, limit + 1);
    const hasMore = keys.length > limit;
    const entities = keys.slice(0, limit).map((key) => ({ ...key, changedAt: null, removed: false }));
    return {
      entities, has_more: hasMore, held_back: null,
      next: hasMore
        ? { phase: "snapshot", position: { start: cursor.position.start, after: keys[limit - 1]! } }
        : { phase: "changes", position: { consumed: cursor.position.start, active: null } },
    };
  }

  const { xmin } = state;
  const { mask } = selection;
  const expand = expandAgentChangeKeys(tx, limit + 1, () => {
    const salary = settings.salary();
    return salary && { families: compileFamilies(salary.role_families), currency: settings.baseCurrency() ?? "" };
  });
  const result = await scanAgentChangePage({
    position: cursor.position, xmin, limit,
    readRows: (after, chunk) => readAgentChangeRows(tx, { xmin, after, mask, limit: chunk }),
    expand: (row, after) => expand(row, after, selection.kindsFor(row.blocks)),
  });
  return {
    entities: result.entities, has_more: result.hasMore, held_back: await countHeldAgentChanges(tx, xmin, mask),
    next: { phase: "changes", position: result.position },
  };
}

/** Cursor scope, retention and every data read share the log identity at the start of the transaction. */
export async function readSyncBatch<Item>(
  ctx: McpContext,
  args: { cursor?: string | null; limit?: number },
  selection: Selection,
  snapshotKeys: SnapshotKeys,
  assemble: (ctx: McpContext, entities: readonly PageEntity[], settings: BlockSettings) => Promise<{ items: Item[]; notices: string[] }>,
) {
  const { cursor: token } = args;
  const limit = syncLimit(ctx, args.limit);
  if (token == null) checkBlockPermissions(ctx, selection);
  try {
    return await withAgentChangeSnapshot(ctx.db, async (tx, state) => {
      const { scope } = selection;
      const cursor = token == null ? null : decodeSyncCursor(token, state, scope);
      checkBlockPermissions(ctx, selection);
      const position: Progress = cursor ?? { phase: "snapshot", position: { start: { tx: state.xmin, seq: "0" }, after: null } };
      const generation = cursor?.generation ?? randomUUID();
      checkAgentChangeRetention(state.prunedThrough, position);
      const settings = jobBlockSettings();
      const { next, entities, ...batch } = await readSyncPage(tx, state, position, selection, limit, snapshotKeys, settings);
      const scoped = { ...ctx, db: tx, permissions: selection.permissions };
      return {
        ...batch,
        ...await assemble(scoped, entities, settings),
        phase: position.phase,
        snapshot_complete: position.phase === "snapshot" && next.phase === "changes",
        generation,
        next_cursor: encodeSyncCursor(state, { ...next, ...scope, generation }),
      };
    });
  } catch (error) {
    if (error instanceof AgentSyncUnavailable) throw new ToolFailure("sync_unavailable", ctx.text("sync.errors.unavailable"));
    if (error instanceof AgentChangesPruned) throw new ToolFailure("resync_required", ctx.text("sync.errors.pruned"));
    if (error instanceof SyncCursorError) {
      if (error.reason === "invalid_cursor") throw new ToolFailure("invalid_cursor", ctx.text("sync.errors.invalidCursor"));
      const message = error.reason === "scope_changed" ? "sync.errors.scopeChanged" : "sync.errors.logReset";
      throw new ToolFailure("resync_required", ctx.text(message));
    }
    throw error;
  }
}

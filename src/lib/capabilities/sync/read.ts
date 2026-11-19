import { randomUUID } from "node:crypto";

import { syncBatchSize } from "@/lib/config/schemas/mcp";
import type { Executor } from "@/lib/db/executor";
import { AgentChangesPruned, checkAgentChangeRetention } from "@/lib/db/repos/agent-change-page";
import { AgentSyncUnavailable, withAgentChangeSnapshot, type AgentChangeSnapshot } from "@/lib/db/repos/agent-changes";
import { SYNC_BLOCKS } from "@/lib/db/sync-sources";
import { ToolFailure, type McpContext } from "@/lib/mcp/context";

import { decodeSyncCursor, encodeSyncCursor, SyncCursorError, type SyncCursor } from "./cursor";
import type { syncSelection } from "./scope";

type Progress = Pick<Extract<SyncCursor, { phase: "snapshot" }>, "phase" | "position"> |
  Pick<Extract<SyncCursor, { phase: "changes" }>, "phase" | "position">;

interface SyncBatch<Item> {
  items: Item[];
  notices: string[];
  has_more: boolean;
  held_back: number | null;
  next: Progress;
}

export function syncLimit(ctx: McpContext, requested: number | undefined): number {
  const max = ctx.settings.sync.max_batch;
  const parsed = syncBatchSize.max(max).safeParse(requested ?? max);
  if (!parsed.success) throw new ToolFailure("invalid_input", ctx.text("sync.errors.limit", { max }));
  return parsed.data;
}

function checkBlockPermissions(ctx: McpContext, selection: ReturnType<typeof syncSelection>): void {
  const [block] = selection.unpermitted;
  if (block) throw new ToolFailure("invalid_input", ctx.text("sync.errors.block", { block, permission: SYNC_BLOCKS[block].permission }));
}

/** Cursor scope, retention and every data read share the log identity at the start of the transaction. */
export async function readSyncBatch<Item>(
  ctx: McpContext,
  token: string | null | undefined,
  selection: ReturnType<typeof syncSelection>,
  read: (tx: Executor, state: AgentChangeSnapshot, cursor: Progress) => Promise<SyncBatch<Item>>,
) {
  if (token == null) checkBlockPermissions(ctx, selection);
  try {
    return await withAgentChangeSnapshot(ctx.db, async (tx, state) => {
      const { scope } = selection;
      const cursor = token == null ? null : decodeSyncCursor(token, state, scope);
      checkBlockPermissions(ctx, selection);
      const position: Progress = cursor ?? { phase: "snapshot", position: { start: { tx: state.xmin, seq: "0" }, after: null } };
      const generation = cursor?.generation ?? randomUUID();
      checkAgentChangeRetention(state.prunedThrough, position);
      const { next, ...batch } = await read(tx, state, position);
      return {
        ...batch,
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

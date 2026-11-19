import { z } from "zod";

import { syncBatchSize, type McpConfig } from "@/lib/config/schemas/mcp";
import { expandAgentChangeKeys, listSyncJobIds } from "@/lib/db/repos/agent-change-keys";
import { scanAgentChangePage } from "@/lib/db/repos/agent-change-page";
import { countHeldAgentChanges, readAgentChangeRows } from "@/lib/db/repos/agent-changes";
import type { McpContext } from "@/lib/mcp/context";
import { listJobChangesOutput, listJobChangesOutputFor, syncJobAssemblyDtoFor, type ListJobChangesOutput, type SyncJobAssembly } from "@/lib/mcp/dto/sync";
import { getJobBlocks, syncJobBlocks } from "@/lib/mcp/job-blocks";
import { assembleJobBlocks } from "@/lib/mcp/job-blocks/assemble";
import { jobBlockSettings } from "@/lib/mcp/job-blocks/settings";
import { compileFamilies } from "@/lib/salary/families";

import { defineCapability, READ_ONLY } from "../types";
import { readSyncBatch, syncLimit } from "./read";
import { syncSelection } from "./scope";

const permission = "jobs:read";
const tool = "list_job_changes";
const jobBlocks = ["job", ...getJobBlocks.map((block) => block.key)] as const;

function listJobChangesInput(ctx: Pick<McpContext, "text">, advertised?: McpConfig) {
  const max = advertised?.sync.max_batch;
  return z.strictObject({
    cursor: z.string({ error: ctx.text("sync.errors.invalidCursor") }).nullish().describe(ctx.text("sync.params.cursor")),
    limit: (max === undefined ? syncBatchSize.optional() : syncBatchSize.max(max).default(max)).describe(ctx.text("sync.params.limit")),
    blocks: z.array(z.enum(jobBlocks)).optional().describe(ctx.text("sync.params.blocks")),
  });
}

type Args = z.infer<ReturnType<typeof listJobChangesInput>>;

async function listJobChanges(ctx: McpContext, args: Args): Promise<ListJobChangesOutput> {
  const permissions = ctx.permissions ?? new Set();
  const defaults = getJobBlocks.filter((block) => !block.onRequest && permissions.has(block.permission)).map((block) => block.key);
  const selection = syncSelection({ tool, permission, kinds: ["job"], permissions, blocks: ["job", ...(args.blocks ?? defaults)] });
  const limit = syncLimit(ctx, args.limit);

  return readSyncBatch<ListJobChangesOutput["items"][number]>(ctx, args.cursor, selection, async (tx, state, cursor) => {
    const scoped = { ...ctx, db: tx, permissions: selection.permissions };
    const blockSettings = jobBlockSettings();
    const assemble = (ids: readonly number[]) => assembleJobBlocks(scoped, ids, {
      blocks: syncJobBlocks, include: selection.scope.blocks, output: syncJobAssemblyDtoFor(selection.permissions), inTransaction: true, blockSettings,
    });
    if (cursor.phase === "snapshot") {
      const ids = await listSyncJobIds(tx, cursor.position.after?.jobId ?? 0, limit + 1);
      const hasMore = ids.length > limit;
      const page = ids.slice(0, limit);
      const last = page.at(-1);
      const { items, notices } = jobItems(page.map((jobId) => ({ jobId, changedAt: null })), await assemble(page));
      return {
        items, notices, has_more: hasMore, held_back: null,
        next: hasMore && last !== undefined
          ? { phase: "snapshot", position: { start: cursor.position.start, after: { jobId: last, kind: "job" } } }
          : { phase: "changes", position: { consumed: cursor.position.start, active: null } },
      };
    }

    const expand = expandAgentChangeKeys(tx, limit + 1, () => {
      const salary = blockSettings.salary();
      return salary && { families: compileFamilies(salary.role_families), currency: blockSettings.baseCurrency() ?? "" };
    });
    const result = await scanAgentChangePage({
      position: cursor.position, xmin: state.xmin, limit,
      readRows: (after, chunk) => readAgentChangeRows(tx, { xmin: state.xmin, after, mask: selection.mask, limit: chunk }),
      expand: (row, after) => expand(row, after, selection.kindsFor(row.blocks)),
    });
    const { items, notices } = jobItems(result.entities, await assemble(result.entities.map(({ jobId }) => jobId)));
    return {
      items, notices, has_more: result.hasMore, held_back: await countHeldAgentChanges(tx, state.xmin, selection.mask),
      next: { phase: "changes", position: result.position },
    };
  });
}

function jobItems(
  entities: readonly { jobId: number; changedAt: Date | null }[],
  jobs: ReadonlyMap<number, SyncJobAssembly>,
) {
  const notices = new Set<string>();
  const items = entities.map(({ jobId, changedAt }): ListJobChangesOutput["items"][number] => {
    const current = jobs.get(jobId);
    const changed_at = changedAt?.toISOString() ?? null;
    if (!current) return { job_id: jobId, removed: true, changed_at, job: null };
    const { notices: jobNotices, ...job } = current;
    for (const notice of jobNotices) notices.add(notice);
    return { job_id: jobId, removed: false, changed_at, job };
  });
  return { items, notices: [...notices] };
}

export const list_job_changes = defineCapability({
  id: tool,
  kind: "read",
  permission,
  input: listJobChangesInput,
  output: listJobChangesOutput,
  outputFor: listJobChangesOutputFor,
  handler: listJobChanges,
  count: (output) => output.items.length,
  annotations: READ_ONLY,
  text: { title: "tools.list_job_changes.title", description: "tools.list_job_changes.description" },
});

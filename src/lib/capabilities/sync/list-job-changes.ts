import type { z } from "zod";

import type { McpConfig } from "@/lib/config/schemas/mcp";
import { listSyncJobKeys } from "@/lib/db/repos/agent-change-keys";
import type { McpContext } from "@/lib/mcp/context";
import { listJobChangesOutput, listJobChangesOutputFor, syncJobAssemblyDtoFor, type ListJobChangesOutput, type SyncJobAssembly } from "@/lib/mcp/dto/sync";
import { getJobBlocks, syncJobBlocks } from "@/lib/mcp/job-blocks";
import { assembleJobBlocks } from "@/lib/mcp/job-blocks/assemble";

import { defineCapability, READ_ONLY } from "../types";
import { readSyncBatch, syncInput } from "./read";
import { syncSelection } from "./scope";

const permission = "jobs:read";
const tool = "list_job_changes";
const jobBlocks = ["job", ...getJobBlocks.map((block) => block.key)] as const;

function listJobChangesInput(ctx: Pick<McpContext, "text">, advertised?: McpConfig) {
  return syncInput(ctx, jobBlocks, ctx.text("sync.params.blocks"), advertised);
}

type Args = z.infer<ReturnType<typeof listJobChangesInput>>;

async function listJobChanges(ctx: McpContext, args: Args): Promise<ListJobChangesOutput> {
  const permissions = ctx.permissions ?? new Set();
  const defaults = getJobBlocks.filter((block) => !block.onRequest && permissions.has(block.permission)).map((block) => block.key);
  const selection = syncSelection({ tool, permission, kinds: ["job"], permissions, blocks: ["job", ...(args.blocks ?? defaults)] });
  return readSyncBatch(ctx, args, selection, listSyncJobKeys, async (scoped, entities, blockSettings) => {
    const jobs = await assembleJobBlocks(scoped, entities.map(({ jobId }) => jobId), {
      blocks: syncJobBlocks, include: selection.scope.blocks, output: syncJobAssemblyDtoFor(selection.permissions), inTransaction: true, blockSettings,
    });
    return jobItems(entities, jobs);
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

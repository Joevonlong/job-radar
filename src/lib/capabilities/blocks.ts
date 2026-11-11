/** Permission-gated field blocks share one selection rule for output schemas and loaders. */
import { z } from "zod";

import type { Permission } from "@/lib/agent-access/permissions";
import type { McpContext } from "@/lib/mcp/context";

/**
 * A value added under `key` only with its effective permission. Its schema is a field-by-field strict object whitelist, optionally
 * nullable; the loader's result is parsed before release. An on-request block also needs its key named in the tool's include input.
 */
export interface FieldBlock<Source> {
  key: string;
  permission: Permission;
  schema: z.ZodType;
  onRequest: boolean;
  load: (ctx: McpContext, source: Source) => Promise<unknown>;
}

export function permittedBlocks<Source>(blocks: readonly FieldBlock<Source>[], permissions: ReadonlySet<Permission>): FieldBlock<Source>[] {
  return blocks.filter((block) => permissions.has(block.permission));
}

export function grantedBlocks<Source>(blocks: readonly FieldBlock<Source>[], permissions: ReadonlySet<Permission>, include: readonly string[] | undefined): FieldBlock<Source>[] {
  return permittedBlocks(blocks, permissions).filter((block) => !block.onRequest || include?.includes(block.key));
}

export function blockShape<Source>(blocks: readonly FieldBlock<Source>[], permissions: ReadonlySet<Permission>): Record<string, z.ZodOptional<z.ZodType>> {
  const shape: Record<string, z.ZodOptional<z.ZodType>> = {};
  for (const block of permittedBlocks(blocks, permissions)) shape[block.key] = block.schema.optional();
  return shape;
}

export function includeInput<Source>(blocks: readonly FieldBlock<Source>[], description: string) {
  const keys = blocks.filter((block) => block.onRequest).map((block) => block.key);
  if (keys.length === 0) throw new Error("includeInput requires an on-request field block");
  return z.array(z.enum(keys)).min(1).max(keys.length).optional().describe(description);
}

/** Missing call permissions withhold every block; granted loaders run in parallel and each value is parsed before release. */
export async function loadBlocks<Source>(blocks: readonly FieldBlock<Source>[], ctx: McpContext, source: Source, include: readonly string[] | undefined): Promise<Record<string, unknown>> {
  const granted = grantedBlocks(blocks, ctx.permissions ?? new Set<Permission>(), include);
  return Object.fromEntries(await Promise.all(granted.map(async (block): Promise<[string, unknown]> => [block.key, block.schema.parse(await block.load(ctx, source))])));
}

export function blockList<Source>(blocks: readonly FieldBlock<Source>[]): { key: string; permission: Permission; onRequest: boolean }[] {
  return blocks.map(({ key, permission, onRequest }) => ({ key, permission, onRequest }));
}

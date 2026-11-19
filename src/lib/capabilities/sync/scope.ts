import type { Permission } from "@/lib/agent-access/permissions";
import { SYNC_BLOCKS, SYNC_DTO_VERSION, type SyncBlock, type SyncEntityKind } from "@/lib/db/sync-sources";

import type { CursorScope } from "./cursor";

const entityKinds = ["application", "favorite", "job"] as const satisfies readonly SyncEntityKind[];

export function syncSelection(input: {
  tool: CursorScope["tool"];
  permission: CursorScope["permissions"][number];
  blocks: readonly SyncBlock[];
  kinds: readonly SyncEntityKind[];
  permissions: ReadonlySet<Permission>;
}) {
  const blocks = [...new Set(input.blocks)].sort();
  const permissions = new Set<CursorScope["permissions"][number]>([input.permission]);
  const masks = { application: 0, favorite: 0, job: 0 };
  const unpermitted: SyncBlock[] = [];
  for (const block of blocks) {
    const definition = SYNC_BLOCKS[block];
    if (!input.permissions.has(definition.permission) || !input.kinds.includes(definition.entity)) {
      unpermitted.push(block);
      continue;
    }
    permissions.add(definition.permission);
    masks[definition.entity] |= 1 << definition.bit;
  }
  const scope: CursorScope = { tool: input.tool, dtoVersion: SYNC_DTO_VERSION, blocks, permissions: [...permissions].sort() };
  return { scope, permissions, unpermitted, mask: masks.application | masks.favorite | masks.job,
    kindsFor: (changed: number) => entityKinds.filter((kind) => (changed & masks[kind]) !== 0),
  };
}

import { and, asc, eq, notInArray, sql } from "drizzle-orm";

import type { Executor } from "../executor";
import { sourceRegistry } from "../schema";

export type SourceRegistryRow = typeof sourceRegistry.$inferSelect;

export interface SourceRegistryRowInput {
  id: string;
  type: "channel" | "ats_board";
  group: string;
  name: string;
  parentId: string | null;
  enabled: boolean;
  params: Record<string, unknown>;
}

/**
 * Mirror config/sources.yaml into `source_registry`: upsert every entry (and bring a removed one back), mark
 * the entries that are no longer in the file as `in_config = false` with `removed_at`. One transaction, idempotent,
 * so the runner and the web app may sync at the same time.
 */
export async function syncSourceRegistryRows(
  db: Executor,
  rows: readonly SourceRegistryRowInput[],
  options: { configHash: string },
): Promise<{ upserted: number; removed: number }> {
  return db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200).map((r) => ({
        id: r.id,
        type: r.type,
        sourceGroup: r.group,
        name: r.name,
        parentId: r.parentId,
        enabled: r.enabled,
        params: r.params,
        inConfig: true,
        removedAt: null,
        configHash: options.configHash,
      }));
      await tx
        .insert(sourceRegistry)
        .values(chunk)
        .onConflictDoUpdate({
          target: sourceRegistry.id,
          set: {
            type: sql`excluded.type`,
            sourceGroup: sql`excluded.source_group`,
            name: sql`excluded.name`,
            parentId: sql`excluded.parent_id`,
            enabled: sql`excluded.enabled`,
            params: sql`excluded.params`,
            inConfig: true,
            removedAt: null,
            configHash: sql`excluded.config_hash`,
            syncedAt: sql`now()`,
          },
        });
    }
    const ids = rows.map((r) => r.id);
    const gone = await tx
      .update(sourceRegistry)
      .set({ inConfig: false, removedAt: sql`coalesce(${sourceRegistry.removedAt}, now())`, configHash: options.configHash, syncedAt: sql`now()` })
      .where(and(eq(sourceRegistry.inConfig, true), ids.length > 0 ? notInArray(sourceRegistry.id, ids) : sql`true`))
      .returning({ id: sourceRegistry.id });
    return { upserted: rows.length, removed: gone.length };
  });
}

/** The mirror rows: those still in the file, plus the removed ones with `includeRemoved`. Channels first, then boards by name. */
export async function listSourceRegistryRows(db: Executor, options: { includeRemoved?: boolean } = {}): Promise<SourceRegistryRow[]> {
  return db
    .select()
    .from(sourceRegistry)
    .where(options.includeRemoved ? undefined : eq(sourceRegistry.inConfig, true))
    .orderBy(asc(sourceRegistry.type), asc(sourceRegistry.name), asc(sourceRegistry.id));
}

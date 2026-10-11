/** Mirror of config/sources.yaml in `source_registry`. The file is the truth; the database follows. */
import { hashConfigText, type ChannelsConfig } from "@/lib/config";
import type { Db } from "@/lib/db";
import { getRuntimeState, setRuntimeState, syncSourceRegistryRows } from "@/lib/db";

import { registryRowsFromConfig } from "./entries";

export const REGISTRY_SYNC_STATE_KEY = "sources.registry_synced";

export interface RegistrySyncState {
  hash: string;
  at: string;
  count: number;
}

/**
 * Upsert every entry of `config` (read from `text`) and mark the entries that left the file. Idempotent; the runner and
 * the web app may both call it. Records hash, time and count in `runtime_state`.
 */
export async function syncSourceRegistry(db: Db, input: { config: ChannelsConfig; text: string; at?: Date }): Promise<{ upserted: number; removed: number }> {
  const hash = hashConfigText(input.text);
  const result = await syncSourceRegistryRows(db, registryRowsFromConfig(input.config), { configHash: hash });
  const state: RegistrySyncState = { hash, at: (input.at ?? new Date()).toISOString(), count: result.upserted };
  await setRuntimeState(db, REGISTRY_SYNC_STATE_KEY, state);
  return result;
}

/** The last recorded sync, or null (never synced / unreadable value). */
export async function readRegistrySyncState(db: Db): Promise<RegistrySyncState | null> {
  const row = await getRuntimeState(db, REGISTRY_SYNC_STATE_KEY);
  const value = row?.value;
  if (typeof value !== "object" || value === null) return null;
  const { hash, at, count } = value as Record<string, unknown>;
  return typeof hash === "string" && typeof at === "string" && typeof count === "number" ? { hash, at, count } : null;
}

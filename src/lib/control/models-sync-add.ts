/**
 * "Add to my list" under the refreshed model list of /settings. The browser sends only a request id and the model ids it ticked:
 * the prices and names come from the stored result of that `models_sync` request (written by the ai-worker), never from the
 * page. The write is `writeModelsOverlay`, the one writer of the user's models.yaml.
 */
import { z } from "zod";

import { catalogEntryFor } from "@/lib/ai/model-sync";
import { configErrorKey, findCatalogModel, loadConfig, ConfigError } from "@/lib/config";
import { writeModelsOverlay } from "@/lib/config/models-overlay-write";
import { getControlRequest, getDb, type Db } from "@/lib/db";
import { logActionFailure } from "@/lib/logging/action-failure";

import { requestResultViewSchema } from "./request-view-schema";

/** The most models one click may add. */
export const MAX_ADD_MODELS = 50;

export const addSyncedModelsSchema = z.strictObject({
  requestId: z.number().int().positive(),
  ids: z.array(z.string().min(1).max(200)).min(1).max(MAX_ADD_MODELS),
});

export type AddSyncedModelsState =
  | { status: "added"; added: string[]; nonce: number }
  | { status: "error"; error: "invalidPayload" | "requestUnavailable" | "notAddable" | "catalogInvalid" | "frozen" | "busy" | "stale" | "protected" | "databaseUnavailable"; nonce: number };

const error = (key: Extract<AddSyncedModelsState, { status: "error" }>["error"]): AddSyncedModelsState => ({ status: "error", error: key, nonce: Date.now() });

export async function addSyncedModels(raw: unknown, db: Db = getDb(), date: string = new Date().toISOString().slice(0, 10)): Promise<AddSyncedModelsState> {
  const parsed = addSyncedModelsSchema.safeParse(raw);
  if (!parsed.success) return error("invalidPayload");
  const { requestId, ids } = parsed.data;
  try {
    const request = await getControlRequest(db, requestId);
    if (!request || request.kind !== "models_sync" || request.status !== "done") return error("requestUnavailable");
    const sync = requestResultViewSchema.safeParse(request.result ?? {}).data?.sync;
    if (!sync) return error("requestUnavailable");
    const byId = new Map(sync.rows.map((row) => [row.id, row]));
    const catalog = loadConfig("models");
    const entries = [];
    for (const id of new Set(ids)) {
      const row = byId.get(id);
      // only models that are not in the catalog yet and may be added without asking (JSON mode stated by the service)
      if (!row || row.inCatalog || !row.addable || findCatalogModel(catalog, sync.provider, id) !== null) return error("notAddable");
      entries.push(catalogEntryFor(row, null, date));
    }
    await writeModelsOverlay(sync.provider, entries);
    return { status: "added", added: entries.map((entry) => entry.id), nonce: Date.now() };
  } catch (failure) {
    if (failure instanceof ConfigError) {
      const key = configErrorKey(failure);
      if (key !== null) return error(key);
      return error("catalogInvalid");
    }
    logActionFailure("addSyncedModels", failure);
    return error("databaseUnavailable");
  }
}

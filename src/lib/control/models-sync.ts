/**
 * `models_sync`: the "refresh models" button of a multi-model provider on /settings. Reads the provider's public model list,
 * compares it with the effective catalog and returns the rows (`SyncResult`) as the request's result; nothing is written here,
 * adding a model is a separate click (`addSyncedModels`). Only the ai-worker on the host claims it, whatever
 * `ai.yaml: execution` says (`kinds.ts`). The payload holds a provider id and an optional filter word, never an address.
 */
import { AiProviderError, sanitize } from "@/lib/ai/errors";
import { buildSyncResult, listProviderModels, type ListDeps } from "@/lib/ai/model-sync";
import { loadConfig, type AiConfig, type ModelsConfig } from "@/lib/config";

import { modelsSyncPayloadSchema, type ControlHandler, type ControlOutcome } from "./types";

export interface ModelsSyncDeps {
  config?: AiConfig;
  catalog?: ModelsConfig;
  list?: ListDeps;
  now?: () => Date;
}

const failed = (error: string, extra: Record<string, unknown> = {}): ControlOutcome => ({ status: "failed", result: { error, ...extra } });

export function createModelsSyncHandler(deps: ModelsSyncDeps = {}): ControlHandler {
  return async (request, context) => {
    const payload = modelsSyncPayloadSchema.safeParse(request.payload);
    if (!payload.success) return failed("invalid_payload");
    const { provider, filter } = payload.data;
    context.logger.info("model list refresh started", { provider });
    try {
      const config = deps.config ?? loadConfig("ai");
      const catalog = deps.catalog ?? loadConfig("models");
      const listed = await listProviderModels(provider, config, { ...deps.list, signal: context.signal });
      const sync = buildSyncResult(provider, listed, catalog, { filter, ...(deps.now ? { now: deps.now() } : {}) });
      context.logger.info("model list refresh finished", { provider, listed: sync.listed, matched: sync.matched });
      return { status: "done", result: { provider, sync } };
    } catch (error) {
      if (context.signal.aborted) throw error;
      // only the kind of failure goes into the result: a provider's message stays in the log
      const errorKind = error instanceof AiProviderError ? error.kind : "provider_error";
      context.logger.warn("model list refresh failed", { provider, kind: errorKind, message: sanitize(error instanceof Error ? error.message : "") });
      return failed("models_sync_failed", { provider, errorKind });
    }
  };
}

export const modelsSyncHandler: ControlHandler = createModelsSyncHandler();

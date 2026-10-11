import fs from "node:fs";
import path from "node:path";

import { createProvider } from "@/lib/ai/provider";
import type { AiUsageEntry } from "@/lib/ai/usage";
import type {
  AiAvailability,
  AiProvider,
  AiProviderId,
  AiTransport,
  AiTransportRequest,
  AiTransportResponse,
} from "@/lib/ai/types";
import { configRegistry, type AiConfig, type ModelsConfig } from "@/lib/config";

import { PINNED_AI_ROUTING, shippedYaml } from "../config/helpers";

export function shippedAi(edit: (raw: Record<string, unknown>) => void = () => {}): AiConfig {
  const raw = structuredClone(shippedYaml("ai.yaml"));
  edit(raw);
  return configRegistry.ai.schema.parse(raw);
}

/** The shipped ai.yaml with the provider routing pinned (`PINNED_AI_ROUTING`); `edit` runs after the pin. */
export function pinnedAi(edit: (raw: Record<string, unknown>) => void = () => {}): AiConfig {
  return shippedAi((raw) => {
    Object.assign(raw, structuredClone(PINNED_AI_ROUTING));
    edit(raw);
  });
}

/** The shipped models.yaml (the model catalog), optionally edited, validated. */
export function shippedCatalog(edit: (raw: Record<string, unknown>) => void = () => {}): ModelsConfig {
  const raw = structuredClone(shippedYaml("models.yaml"));
  edit(raw);
  return configRegistry.models.schema.parse(raw);
}

/**
 * The shipped catalog with every optional `equivalent_price` removed, then `edit` applied: tests that
 * care about equivalent prices set exactly the ones they need, whatever the shipped models.yaml carries.
 */
export function bareCatalog(edit: (raw: Record<string, unknown>) => void = () => {}): ModelsConfig {
  return shippedCatalog((raw) => {
    const providers = raw.providers as Record<string, { models: Record<string, unknown>[] }>;
    for (const provider of Object.values(providers)) for (const model of provider.models) delete model.equivalent_price;
    edit(raw);
  });
}

export function fixtureText(name: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, "../fixtures/ai", name), "utf8");
}

/** A usage entry with every usage field filled in (unknown / legacy defaults); `entry` overrides. */
export function usageEntry(entry: Pick<AiUsageEntry, "provider" | "task" | "at"> & Partial<AiUsageEntry>): AiUsageEntry {
  return {
    model: null,
    modelSource: null,
    tokensIn: 0,
    tokensInCached: null,
    tokensInCacheWrite: null,
    tokensOut: 0,
    tokensOutReasoning: null,
    durationMs: null,
    outcome: "ok",
    errorKind: null,
    costUsd: 0,
    equivalentUsd: null,
    jobId: null,
    ...entry,
  };
}

export type Step =
  | string
  | Error
  | { text: string; tokensIn?: number; tokensOut?: number; model?: string; cachedIn?: number; cacheWriteIn?: number; reasoningOut?: number; reported?: boolean; webSearches?: number };

export interface ScriptedTransport extends AiTransport {
  calls: AiTransportRequest[];
}

/** A transport that plays back `steps` (the last one repeats): a reply text, or an error to throw. */
export function scripted(id: AiProviderId, steps: Step[], availability: AiAvailability = { available: true }, model = `${id}-model`): ScriptedTransport {
  const calls: AiTransportRequest[] = [];
  return {
    id,
    calls,
    availability: () => availability,
    async call(request): Promise<AiTransportResponse> {
      calls.push(request);
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      if (step === undefined) throw new Error("scripted: no steps");
      if (step instanceof Error) throw step;
      const detail = typeof step === "string" ? { text: step } : step;
      return {
        text: detail.text,
        model: detail.model ?? model,
        usage: {
          tokensIn: detail.tokensIn ?? 100,
          tokensOut: detail.tokensOut ?? 10,
          ...(detail.cachedIn !== undefined ? { cachedIn: detail.cachedIn } : {}),
          ...(detail.cacheWriteIn !== undefined ? { cacheWriteIn: detail.cacheWriteIn } : {}),
          ...(detail.reasoningOut !== undefined ? { reasoningOut: detail.reasoningOut } : {}),
          ...(detail.reported !== undefined ? { reported: detail.reported } : {}),
          ...(detail.webSearches !== undefined ? { webSearches: detail.webSearches } : {}),
        },
      };
    },
    plannedModel: () => model,
  };
}

export function scriptedProvider(id: AiProviderId, steps: Step[], availability?: AiAvailability, model?: string): { provider: AiProvider; transport: ScriptedTransport } {
  const transport = scripted(id, steps, availability, model);
  return { provider: createProvider(transport), transport };
}

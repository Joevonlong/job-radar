/**
 * `test_ai`: the "test" button of a provider in the AI health card on /sources. The same tiny structured
 * request as `pnpm ai:probe`, sent through the normal router limited to this one provider, so every gate applies
 * (switched off, cooling down, daily cap, API key, monthly API budget), the call counts against today's cap, lands in
 * the shared health record and in `ai_usage` (task `probe`). An AI kind: only the ai-worker claims it
 * while `ai.yaml: execution: host`.
 */
import { z } from "zod";

import { AiProviderError, AiUnavailableError } from "@/lib/ai/errors";
import { createDbHealthStore, type AiHealthStore } from "@/lib/ai/health";
import { createDefaultProviders } from "@/lib/ai/providers";
import { createAiRouter } from "@/lib/ai/router";
import type { AiProvider, AiProviderId } from "@/lib/ai/types";
import { AI_PROBE_TASK, createDbUsageStore, type AiUsageStore } from "@/lib/ai/usage";
import { loadConfig, type AiConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";

import { testAiPayloadSchema, type ControlHandler, type ControlOutcome } from "./types";

const probeSchema = z.object({ answer: z.string() });
const PROBE_PROMPT = { system: "You answer in JSON only.", user: 'Reply with the JSON object {"answer": "ok"}.' };

export interface TestAiDeps {
  config?: AiConfig;
  timeZone?: string;
  providers?: (config: AiConfig) => readonly AiProvider[];
  usage?: (db: Db) => AiUsageStore;
  health?: (db: Db) => AiHealthStore;
  now?: () => Date;
}

const failed = (error: string, extra: Record<string, unknown> = {}): ControlOutcome => ({ status: "failed", result: { error, ...extra } });

/** The ai.yaml copy whose `score` order names only `provider`: the router then tries exactly that one. */
function onlyProvider(config: AiConfig, provider: AiProviderId): AiConfig {
  return { ...config, tasks: { ...config.tasks, score: { order: [provider] } } };
}

export function createTestAiHandler(deps: TestAiDeps = {}): ControlHandler {
  return async (request, context) => {
    const payload = testAiPayloadSchema.safeParse(request.payload);
    if (!payload.success) return failed("invalid_payload");
    const { provider } = payload.data;
    const config = deps.config ?? loadConfig("ai");
    const usage = (deps.usage ?? createDbUsageStore)(context.db);
    const router = createAiRouter({
      config: onlyProvider(config, provider),
      providers: (deps.providers ?? createDefaultProviders)(config),
      // the probe's tokens are recorded under their own task name
      usage: { record: (entry) => usage.record({ ...entry, task: AI_PROBE_TASK }), apiSpendUsd: (month, timeZone) => usage.apiSpendUsd(month, timeZone) },
      timeZone: deps.timeZone ?? loadConfig("schedule").timezone,
      health: (deps.health ?? createDbHealthStore)(context.db),
      logger: context.logger,
      ...(deps.now ? { now: deps.now } : {}),
    });

    const now = deps.now ?? (() => new Date());
    const started = now().getTime();
    context.logger.info("ai provider test started", { provider });
    try {
      const result = await router.run("score", PROBE_PROMPT, probeSchema, { signal: context.signal });
      const latencyMs = now().getTime() - started;
      context.logger.info("ai provider test finished", { provider, model: result.model, latencyMs });
      return {
        status: "done",
        result: { provider, model: result.model, latencyMs, tokensIn: result.usage.tokensIn, tokensOut: result.usage.tokensOut, costUsd: result.usage.costUsd },
      };
    } catch (error) {
      if (context.signal.aborted) throw error;
      // only the kind goes into the result: provider messages may quote the CLI's output (C4: they stay in the log)
      const errorKind =
        error instanceof AiUnavailableError ? (error.attempts.find((a) => a.provider === provider)?.kind ?? "not_configured") : error instanceof AiProviderError ? error.kind : "provider_error";
      const skipped = error instanceof AiUnavailableError && error.attempts.find((a) => a.provider === provider)?.outcome === "skipped";
      context.logger.warn("ai provider test failed", { provider, kind: errorKind, skipped });
      return failed(skipped ? "ai_unavailable" : "ai_test_failed", { provider, errorKind, latencyMs: now().getTime() - started });
    }
  };
}

export const testAiHandler: ControlHandler = createTestAiHandler();

import { createAiRouter, createDbUsageStore, createDefaultProviders, type AiProvider, type AiRouter } from "@/lib/ai";
import { createDbHealthStore } from "@/lib/ai/health";
import type { ChannelLogger } from "@/lib/channels/types";
import { loadConfig, type AiConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";

/** Test seams: the configuration and providers to use instead of ai.yaml and the real ones. */
export interface RequestRouterOverrides {
  config?: AiConfig;
  providers?: readonly AiProvider[];
  timeZone?: string;
  now?: () => Date;
}

/**
 * The normal AI router for requests that happen outside a cycle (translate, breakdown, salary lookup): providers and
 * order from ai.yaml, usage written to `ai_usage`, and the shared provider health (`runtime_state`), so a provider
 * at its daily cap or cooling down is skipped here too, and a login failure shows on Settings and /sources.
 */
export function createRequestRouter(db: Db, logger?: ChannelLogger, overrides: RequestRouterOverrides = {}): AiRouter {
  const config = overrides.config ?? loadConfig("ai");
  return createAiRouter({
    config,
    providers: overrides.providers ?? createDefaultProviders(config),
    usage: createDbUsageStore(db),
    health: createDbHealthStore(db),
    timeZone: overrides.timeZone ?? loadConfig("schedule").timezone,
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(logger ? { logger } : {}),
  });
}

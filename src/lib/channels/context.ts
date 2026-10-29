import type { ChannelsConfig } from "@/lib/config";
import type { CycleKind } from "@/lib/db/repos/cycles";

import { NO_DELIVERIES, type DeliveryRecorder } from "./delivery";
import { defaultSleep, createHttpClient, type FetchLike, type HttpSettings, type SleepFn } from "./http";
import { silentLogger } from "./logger";
import type { ChannelBudget, ChannelContext, ChannelLogger, ChannelRuntimeSettings, KnownPostings } from "./types";

export function httpSettingsFromConfig(config: ChannelsConfig): HttpSettings {
  return {
    timeoutMs: config.http.timeout_ms,
    maxRetries: config.http.max_retries,
    backoffBaseMs: config.http.backoff_base_ms,
    backoffMaxMs: config.http.backoff_max_ms,
  };
}

/** Knows nothing: every posting counts as new. */
export const NO_KNOWN_POSTINGS: KnownPostings = { payloads: async () => new Map() };

export interface ThrottleOptions {
  settings: Pick<ChannelRuntimeSettings, "throttle">;
  signal?: AbortSignal;
  sleep?: SleepFn;
  random?: () => number;
}

/** Wait a uniformly random time between the channel's min and max delay. */
export function createThrottle(options: ThrottleOptions): () => Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  return async () => {
    const { minDelayMs, maxDelayMs } = options.settings.throttle;
    const delay = Math.round(minDelayMs + random() * (maxDelayMs - minDelayMs));
    if (delay > 0) await sleep(delay, options.signal);
  };
}

export interface ChannelContextOptions {
  channelId: string;
  settings: ChannelRuntimeSettings;
  http: HttpSettings;
  budget: ChannelBudget;
  signal: AbortSignal;
  cycle: { id: number | null; kind: CycleKind };
  logger?: ChannelLogger;
  /** Stored postings of the channel; defaults to none. */
  known?: KnownPostings;
  deliveries?: DeliveryRecorder;
  fetch?: FetchLike;
  sleep?: SleepFn;
  random?: () => number;
  now?: () => Date;
}

/** Everything a channel's `collect` may touch, wired for one attempt. */
export function createChannelContext(options: ChannelContextOptions): ChannelContext {
  const logger = (options.logger ?? silentLogger).child({ channel: options.channelId });
  const shared = {
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.random ? { random: options.random } : {}),
  };
  return {
    http: createHttpClient({
      settings: options.http,
      signal: options.signal,
      logger,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...shared,
    }),
    throttle: createThrottle({ settings: options.settings, signal: options.signal, ...shared }),
    budget: options.budget,
    signal: options.signal,
    logger,
    cycle: options.cycle,
    settings: options.settings,
    known: options.known ?? NO_KNOWN_POSTINGS,
    deliveries: options.deliveries ?? NO_DELIVERIES,
  };
}

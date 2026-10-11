import { FIXTURE_SETTINGS } from "@/lib/channels/fixture";
import { createLogger } from "@/lib/channels/logger";
import type { Channel, ChannelRuntimeSettings, NormalizedPostingDraft, RawPostingInput } from "@/lib/channels/types";
import type { CollectResult } from "@/lib/cycle/collect";
import type { CycleRunResult } from "@/lib/cycle/run-cycle";

import { shippedChannels, shippedSchedule, shippedSearch } from "../channels/helpers";

export const quietLogger = createLogger({ sink: () => {} });

/**
 * A fixed search config for tests whose arithmetic depends on the query shape (3 groups x (2 cities + remote) = 9 queries,
 * one short keyword string per query, 25 results per query), so editing the shipped keyword lists cannot break them.
 */
export function pinnedSearch() {
  return {
    ...shippedSearch(),
    keyword_groups: { engineering: ["AI Engineer"], fde_solutions: ["Forward Deployed Engineer"], german: ["KI Engineer"] },
    locations: ["Berlin", "München"],
    max_per_group_per_location: 25,
  };
}

export function config(overrides: { concurrency?: number; search?: ReturnType<typeof shippedSearch> } = {}) {
  const channels = shippedChannels();
  return {
    channels: overrides.concurrency === undefined ? channels : { ...channels, collect: { concurrency: overrides.concurrency } },
    search: overrides.search ?? shippedSearch(),
    schedule: shippedSchedule(),
  };
}

export function settings(overrides: Partial<ChannelRuntimeSettings> = {}): ChannelRuntimeSettings {
  return { ...FIXTURE_SETTINGS, ...overrides };
}

const EMPTY_DRAFT: NormalizedPostingDraft = {
  title: "t",
  companyName: "c",
  locations: [],
  workplace: "unknown",
  description: "",
  applyUrl: null,
  sourceUrl: null,
};

export interface ProbeChannel extends Channel {
  /** Maximum number of `collect` calls running at the same time, across all probes sharing `shared`. */
  readonly calls: { query: string; maxResults: number }[];
}

export interface SharedProbe {
  current: number;
  max: number;
}

/** A hand-rolled channel for orchestration tests: records calls and concurrency, optionally waits. */
export function probeChannel(
  id: string,
  options: {
    shared?: SharedProbe;
    waitMs?: number;
    /** Hold every collect() until this promise resolves: a deterministic alternative to `waitMs`. */
    gate?: Promise<void>;
    records?: (query: string) => RawPostingInput[];
    usesQueries?: boolean;
    throws?: unknown;
  } = {},
): ProbeChannel {
  const calls: ProbeChannel["calls"] = [];
  let own = 0;
  return {
    id,
    family: "ats",
    kind: "api",
    usesQueries: options.usesQueries ?? true,
    calls,
    async collect(query) {
      calls.push({ query: query.id, maxResults: query.maxResults });
      own += 1;
      if (own > 1) throw new Error(`channel ${id} ran two queries at once`);
      if (options.shared) {
        options.shared.current += 1;
        options.shared.max = Math.max(options.shared.max, options.shared.current);
      }
      try {
        if (options.gate) await options.gate;
        if (options.waitMs) await new Promise((resolve) => setTimeout(resolve, options.waitMs));
        if (options.throws !== undefined) throw options.throws;
        return options.records?.(query.id) ?? [{ externalId: `${id}-1`, url: null, payload: { id } }];
      } finally {
        own -= 1;
        if (options.shared) options.shared.current -= 1;
      }
    },
    parse: () => EMPTY_DRAFT,
  };
}

export function collectOf(result: CycleRunResult): CollectResult {
  const collect = result.results.collect;
  if (!collect) throw new Error("no collect result");
  return collect as CollectResult;
}

import type { ChannelsConfig } from "@/lib/config";
import { loadMarket } from "@/lib/market/resolve";

import type { Channel, ChannelRuntimeSettings } from "./types";

import { CHANNEL_CONFIG_TABLE, isConfiguredChannelId, type ChannelConfigRef, type ConfiguredChannelId } from "./config-table";
export { CHANNEL_CONFIG_TABLE, channelUsesQueries, channelSupportsCompanyQueries, channelStatesPostedAt, isConfiguredChannelId, type ChannelConfigRef, type ConfiguredChannelId } from "./config-table";

/** Records a channel may use per month before they cost money: Bright Data's free allowance, JSearch's plan requests, Tavily's plan credits. */
function includedRecords(ref: ChannelConfigRef, config: ChannelsConfig): number {
  if (ref.section === "linkedin") return ref.key === "brightdata" ? config.linkedin.brightdata.free_records_per_month : 0;
  if (ref.key === "jsearch") return config.sources.jsearch.monthly_request_limit;
  return ref.key === "tavily" ? config.sources.tavily.monthly_credit_limit : 0;
}

/** Runtime settings of a config-backed channel, read from a validated sources.yaml. */
/** The market's home country for `markets`; null when the market cannot be resolved (then no market-bound channel runs). */
function homeCountry(): string | null {
  try {
    return loadMarket().country;
  } catch {
    return null;
  }
}

/** Whether a channel's `markets` leave out the current market. */
export function isOtherMarket(markets: readonly string[] | undefined, country: string | null = homeCountry()): boolean {
  return markets !== undefined && (country === null || !markets.includes(country));
}

export function settingsFromConfig(id: ConfiguredChannelId, config: ChannelsConfig): ChannelRuntimeSettings {
  const ref: ChannelConfigRef = CHANNEL_CONFIG_TABLE[id];
  const block = ref.section === "linkedin" ? config.linkedin[ref.key] : config.sources[ref.key];
  const markets = block.markets ?? [];
  const otherMarket = isOtherMarket(block.markets);
  if (ref.section === "linkedin" && ref.view === "recommended") {
    const session = config.linkedin.session;
    return {
      enabled: session.enabled && session.recommended_daily && !otherMarket,
      companyQueries: false,
      otherMarket,
      markets,
      maxResults: session.recommended_max_results,
      monthlyBudgetUsd: session.monthly_budget_usd,
      freeRecordsPerMonth: 0,
      throttle: { minDelayMs: session.throttle.min_delay_ms, maxDelayMs: session.throttle.max_delay_ms },
      extra: session,
    };
  }
  return {
    enabled: block.enabled && !otherMarket,
    companyQueries: "company_queries" in block ? block.company_queries : false,
    otherMarket,
    markets,
    maxResults: block.max_results,
    monthlyBudgetUsd: block.monthly_budget_usd,
    freeRecordsPerMonth: includedRecords(ref, config),
    throttle: { minDelayMs: block.throttle.min_delay_ms, maxDelayMs: block.throttle.max_delay_ms },
    extra: block,
  };
}

export interface RegisterOptions {
  /** Settings that replace the config lookup (fixture and test channels, which have no sources.yaml block). */
  settings?: ChannelRuntimeSettings;
}

interface Entry {
  channel: Channel;
  settings: ChannelRuntimeSettings | undefined;
}

/** Channels known to the process. Code registers them; sources.yaml decides which are enabled. */
export class ChannelRegistry {
  private readonly entries = new Map<string, Entry>();

  register(channel: Channel, options: RegisterOptions = {}): void {
    if (this.entries.has(channel.id)) throw new Error(`channel "${channel.id}" is already registered`);
    if (!options.settings && !isConfiguredChannelId(channel.id)) {
      throw new Error(
        `channel "${channel.id}" has no entry in CHANNEL_CONFIG_TABLE (src/lib/channels/registry.ts); add its sources.yaml key there`,
      );
    }
    this.entries.set(channel.id, { channel, settings: options.settings });
  }

  unregister(id: string): void {
    this.entries.delete(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): Channel | undefined {
    return this.entries.get(id)?.channel;
  }

  list(): Channel[] {
    return [...this.entries.values()].map((e) => e.channel);
  }

  settingsFor(id: string, config: ChannelsConfig): ChannelRuntimeSettings | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.settings) return entry.settings;
    return isConfiguredChannelId(id) ? settingsFromConfig(id, config) : undefined;
  }

  isEnabled(id: string, config: ChannelsConfig): boolean {
    return this.settingsFor(id, config)?.enabled ?? false;
  }

  enabled(config: ChannelsConfig): Channel[] {
    return this.list().filter((c) => this.isEnabled(c.id, config));
  }
}

/** Process-wide registry that real channels add themselves to. */
export const defaultRegistry = new ChannelRegistry();

export function registerChannel(channel: Channel, options?: RegisterOptions): void {
  defaultRegistry.register(channel, options);
}

/**
 * The market in one object, for `pnpm market:show` and the doctor's `config.market` check: which pack (shipped or
 * a user copy), the home country, base currency and local language, whether the local-language step is on, and which
 * channels run in this market. Never throws: an unresolvable market comes back as `{ ok: false, reason }`.
 */
import { CHANNEL_CONFIG_TABLE, settingsFromConfig, type ConfiguredChannelId } from "@/lib/channels/registry";
import { ConfigError, loadConfig } from "@/lib/config";
import { firstConfigProblem } from "@/lib/config/errors";

import { loadMarketPacks, loadMarket, MarketUnresolvedError } from "./resolve";

export interface MarketSummary {
  packId: string;
  packName: string;
  /** `user`: a copy in the user config directory replaces the shipped pack (product updates of it do not apply). */
  packLayer: "shipped" | "user";
  packDir: string;
  country: string;
  countryName: string;
  currency: string;
  homeLanguage: string;
  locale: string;
  homeRegion: string | null;
  /** The local-language step is on (the pack has requirement rules for the home language). */
  languageStep: boolean;
  channels: {
    /** Switched on and allowed in this market: they run. */
    running: string[];
    /** The pack's own job boards (`default_channels`) that are switched off. */
    localOff: string[];
    /** Bound to other markets (`markets:` in sources.yaml): they do not run here, whatever `enabled` says. */
    otherMarket: Array<{ id: string; markets: string[] }>;
  } | null;
  /** Why the channel list is missing (sources.yaml cannot be read). */
  channelsError: string | null;
}

export type MarketSummaryResult = { ok: true; summary: MarketSummary } | { ok: false; reason: string };

export function summarizeMarket(): MarketSummaryResult {
  let market;
  try {
    market = loadMarket();
  } catch (error) {
    if (error instanceof MarketUnresolvedError) return { ok: false, reason: error.reason };
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const { pack } = loadMarketPacks(market.packId);
  let channels: MarketSummary["channels"] = null;
  let channelsError: string | null = null;
  try {
    const config = loadConfig("channels");
    const running: string[] = [];
    const otherMarket: Array<{ id: string; markets: string[] }> = [];
    for (const id of Object.keys(CHANNEL_CONFIG_TABLE) as ConfiguredChannelId[]) {
      const settings = settingsFromConfig(id, config);
      if (settings.otherMarket) otherMarket.push({ id, markets: [...(settings.markets ?? [])] });
      else if (settings.enabled) running.push(id);
    }
    const localOff = market.defaultChannels.filter((id) => !running.includes(id) && !otherMarket.some((o) => o.id === id));
    channels = { running, localOff, otherMarket };
  } catch (error) {
    channelsError = error instanceof ConfigError ? firstConfigProblem(error) : error instanceof Error ? error.message : String(error);
  }
  return {
    ok: true,
    summary: {
      packId: market.packId,
      packName: market.packName,
      packLayer: pack.layer,
      packDir: pack.dir,
      country: market.country,
      countryName: market.countryName,
      currency: market.currency,
      homeLanguage: market.homeLanguage,
      locale: market.locale,
      homeRegion: market.homeRegion,
      languageStep: market.language !== null,
      channels,
      channelsError,
    },
  };
}

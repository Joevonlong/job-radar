import { loadMarket, MarketUnresolvedError } from "@/lib/market/resolve";
import type { Market } from "@/lib/market/types";

import { ChannelError } from "./errors";

/** What a channel needs of the market: the home country for "follow the market" parameters and remote locations. */
export type ChannelMarket = Pick<Market, "country" | "countryName" | "regions" | "countries">;

/** The current market for a channel; an unresolvable market fails only this channel (C2), never the cycle. */
export function marketForChannel(): ChannelMarket {
  try {
    return loadMarket();
  } catch (error) {
    if (error instanceof MarketUnresolvedError) throw new ChannelError("unknown", error.message, { retryable: false });
    throw error;
  }
}

/** The Indeed country name of the market's home country (python-jobspy's spelling), or null when Indeed does not serve it. */
export function indeedCountryOf(market: ChannelMarket): string | null {
  return market.countries.find((c) => c.code === market.country)?.indeed ?? null;
}

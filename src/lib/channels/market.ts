import { loadPipeline } from "@/lib/market/effective";
import { placeDictionary } from "@/lib/market/geo";
import { placeGeo, type PlaceGeo } from "@/lib/market/places";
import { loadMarket, MarketUnresolvedError } from "@/lib/market/resolve";
import type { Market } from "@/lib/market/types";

import { ChannelError } from "./errors";

/** What a channel needs of the market: the home country for "follow the market" parameters and remote locations. */
export type ChannelMarket = Pick<Market, "country" | "countryName" | "regions" | "countries">;

/** The current market for a channel; an unresolvable market fails only this channel, never the cycle. */
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

/** The market's place tables with the place dictionary, for a channel that names places its own way; fails like `marketForChannel`. */
export function placeGeoForChannel(): PlaceGeo {
  try {
    return placeGeo(loadPipeline(), placeDictionary());
  } catch (error) {
    if (error instanceof MarketUnresolvedError) throw new ChannelError("unknown", error.message, { retryable: false });
    throw error;
  }
}

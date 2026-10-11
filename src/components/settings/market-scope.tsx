"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { ScopeOption } from "@/lib/market/view";

/** What the remote-scope editor of the settings page can offer: the market's regions and countries, and the home country's name. */
export interface MarketScopeChoices {
  options: readonly ScopeOption[];
  countryName: string;
}

const MarketScopeContext = createContext<MarketScopeChoices>({ options: [], countryName: "" });

export function MarketScopeProvider({ value, children }: { value: MarketScopeChoices; children: ReactNode }) {
  return <MarketScopeContext.Provider value={value}>{children}</MarketScopeContext.Provider>;
}

export function useMarketScope(): MarketScopeChoices {
  return useContext(MarketScopeContext);
}

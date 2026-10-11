"use client";

import { useLocale } from "next-intl";
import { createContext, useContext, type ReactNode } from "react";

/**
 * What client components need of the market: the base currency (salary floors, axes, medians and converted figures
 * are in it; "" when the market cannot be resolved) and the local language whose requirement is read (null = the language
 * step is off: its filters, badges and panels are not shown). The root layout provides it.
 */
interface MarketContextValue {
  currency: string;
  language: string | null;
}

const MarketContext = createContext<MarketContextValue>({ currency: "", language: null });

export function BaseCurrencyProvider({ currency, language = null, children }: { currency: string; language?: string | null; children: ReactNode }) {
  return <MarketContext.Provider value={{ currency, language }}>{children}</MarketContext.Provider>;
}

export function useBaseCurrency(): string {
  return useContext(MarketContext).currency;
}

/** The local language as the page names it ("德语", "German"), or null when its step is off. */
export function useLocalLanguageName(): string | null {
  const { language } = useContext(MarketContext);
  const locale = useLocale();
  if (language === null) return null;
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(language) ?? language;
  } catch {
    return language;
  }
}

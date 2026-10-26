/**
 * What the pages show of the market (server only): names in the page's language, the regions and countries a
 * remote scope can name, whether the local-language step is on, and the currency symbol. Serializable for client
 * components. Never throws: an unresolvable market comes back with `error` (the pages then show the reason).
 */
import { isConfiguredChannelId, settingsFromConfig } from "@/lib/channels/registry";
import { loadConfig } from "@/lib/config";

import { GENERIC_PACK_ID, listPackIds, loadPack } from "./load";
import { loadMarket, MarketUnresolvedError } from "./resolve";
import type { Market } from "./types";

/** Region ids that have a translated name in `messages/*.json` `market.regions`; others show the pack's English name. */
export const TRANSLATED_REGIONS = ["eu", "eea", "europe", "dach", "nordics"] as const;
export type TranslatedRegion = (typeof TRANSLATED_REGIONS)[number];
export const isTranslatedRegion = (id: string): id is TranslatedRegion => (TRANSLATED_REGIONS as readonly string[]).includes(id);

export interface ScopeOption {
  value: string;
  label: string;
  group: "regions" | "countries";
}

export interface PackOption {
  id: string;
  /** The pack's English name. */
  name: string;
  /** What the pack sets when preferences.yaml leaves the value out (null: the pack names none, the user must). */
  country: string | null;
  currency: string | null;
  language: string | null;
  /** The pack has requirement rules for its language (the local-language step can be on). */
  languageRules: boolean;
}

export interface MarketView {
  /** null when the market resolves; else one line saying why not. */
  error: string | null;
  packId: string;
  packName: string;
  /** Packs that can be chosen, sorted by id. */
  packs: PackOption[];
  /** Every country of the table (code + name in the page's language), sorted by name: the home-country choices. */
  countryOptions: Array<{ value: string; label: string }>;
  /** ISO 4217 currencies the runtime knows (code + name in the page's language). */
  currencyOptions: Array<{ value: string; label: string }>;
  /** Currencies the salary pipeline can convert (the `fx_pivot` and the `fx_rates` keys of pipeline.yaml); empty when pipeline.yaml cannot be read. */
  rateCurrencies: string[];
  /** The market's own job boards (the pack's `default_channels`) and whether each is on. */
  localChannels: Array<{ id: string; enabled: boolean }>;
  country: string;
  /** The home country's name in the page's language. */
  countryName: string;
  currency: string;
  /** "€", "$", "CHF" … in the page's language. */
  currencySymbol: string;
  homeLanguage: string;
  /** The local language's name in the page's language ("德语", "German"). */
  languageName: string;
  /** The local-language step is on (the pack has rules for the language). */
  languageStep: boolean;
  /** Regions first (named regions of the packs), then every country of the table. */
  scopeOptions: ScopeOption[];
  /** The named region the home country belongs to (what "remote in the home region" means), with its name in the page's language; null when it has none. */
  homeRegion: { id: string; name: string } | null;
}

/** The symbol a currency is written with in a locale ("€", "US$" -> "$" with `narrowSymbol`). */
export function currencySymbol(currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: "narrowSymbol" }).formatToParts(0).find((p) => p.type === "currency")?.value ?? currency;
  } catch {
    return currency;
  }
}

/** A language's name in a locale (`de` in zh -> 德语). */
export function languageDisplayName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** A country's name in a locale (`DE` in zh -> 德国); the table's English name when Intl does not know the code. */
export function countryDisplayName(code: string, locale: string, fallback = code): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: "region", fallback: "none" }).of(code);
    return name ?? fallback;
  } catch {
    return fallback;
  }
}

function packList(): PackOption[] {
  return listPackIds().flatMap((id): PackOption[] => {
    try {
      const pack = loadPack(id);
      const { meta } = pack;
      return [{ id, name: meta.name, country: meta.country ?? null, currency: meta.currency ?? null, language: meta.language ?? null, languageRules: pack.language.requirement !== undefined }];
    } catch {
      return [];
    }
  });
}

function countryOptions(countries: ReadonlyArray<{ code: string; name: string }>, locale: string): Array<{ value: string; label: string }> {
  return countries.map((c) => ({ value: c.code, label: countryDisplayName(c.code, locale, c.name) })).sort((a, b) => a.label.localeCompare(b.label, locale));
}

function genericCountries(): ReadonlyArray<{ code: string; name: string }> {
  try {
    return loadPack(GENERIC_PACK_ID).geography.countries;
  } catch {
    return [];
  }
}

function currencyOptions(locale: string): Array<{ value: string; label: string }> {
  let codes: string[] = [];
  try {
    codes = Intl.supportedValuesOf("currency");
  } catch {
    return [];
  }
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([locale], { type: "currency" });
  } catch {
    names = null;
  }
  return codes.map((code) => ({ value: code, label: `${code} · ${names?.of(code) ?? code}` }));
}

/** The currencies pipeline.yaml can convert; none when it cannot be read (the pages then say nothing about rates). */
function rateCurrencies(): string[] {
  try {
    const { fx_pivot, fx_rates } = loadConfig("pipeline").salary;
    return [fx_pivot, ...Object.keys(fx_rates)];
  } catch {
    return [];
  }
}

/** The pack's own job boards and whether each is on in sources.yaml (empty when sources.yaml cannot be read). */
function localChannels(ids: readonly string[]): Array<{ id: string; enabled: boolean }> {
  try {
    const config = loadConfig("channels");
    return ids.filter(isConfiguredChannelId).map((id) => ({ id, enabled: settingsFromConfig(id, config).enabled }));
  } catch {
    return [];
  }
}

/** The market's local language when its step is on (the code), else null; null too when the market cannot be resolved. */
export function loadLocalLanguage(): string | null {
  try {
    return loadMarket().language?.code ?? null;
  } catch {
    return null;
  }
}

/** The local language as a page in `locale` names it ("德语", "German"), or null when its step is off. */
export function localLanguageName(locale: string): string | null {
  const code = loadLocalLanguage();
  return code === null ? null : languageDisplayName(code, locale);
}

/** The view of a resolved market. `regionLabel` names a region id in the page's language (null: use the pack's name). */
export function marketViewOf(market: Market, locale: string, regionLabel: (id: string) => string | null): MarketView {
  const regions = Object.entries(market.regions).map(([id, region]): ScopeOption => ({ value: id, label: regionLabel(id) ?? region.name, group: "regions" }));
  const countries = [...market.countries]
    .map((c): ScopeOption => ({ value: c.code, label: countryDisplayName(c.code, locale, c.name), group: "countries" }))
    .sort((a, b) => a.label.localeCompare(b.label, locale));
  return {
    error: null,
    packId: market.packId,
    packName: market.packName,
    packs: packList(),
    countryOptions: countryOptions(market.countries, locale),
    currencyOptions: currencyOptions(locale),
    rateCurrencies: rateCurrencies(),
    localChannels: localChannels(market.defaultChannels),
    country: market.country,
    countryName: countryDisplayName(market.country, locale, market.countryName),
    currency: market.currency,
    currencySymbol: currencySymbol(market.currency, locale),
    homeLanguage: market.homeLanguage,
    languageName: languageDisplayName(market.homeLanguage, locale),
    languageStep: market.language !== null,
    scopeOptions: [...regions, ...countries],
    homeRegion: market.homeRegion === null ? null : { id: market.homeRegion, name: regionLabel(market.homeRegion) ?? market.regions[market.homeRegion]?.name ?? market.homeRegion },
  };
}

/** The market view of the current preferences (see the module comment). */
export function loadMarketView(locale: string, regionLabel: (id: string) => string | null): MarketView {
  try {
    return marketViewOf(loadMarket(), locale, regionLabel);
  } catch (error) {
    const reason = error instanceof MarketUnresolvedError ? error.reason : error instanceof Error ? error.message : "unknown error";
    return {
      error: reason,
      packId: "",
      packName: "",
      packs: packList(),
      countryOptions: countryOptions(genericCountries(), locale),
      currencyOptions: currencyOptions(locale),
      rateCurrencies: [],
      localChannels: [],
      country: "",
      countryName: "",
      currency: "",
      currencySymbol: "",
      homeLanguage: "",
      languageName: "",
      languageStep: false,
      scopeOptions: [],
      homeRegion: null,
    };
  }
}

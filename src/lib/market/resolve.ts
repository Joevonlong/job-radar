/**
 * preferences.yaml `market` + packs -> the market the code works with. Fail-closed: when the market cannot be
 * resolved (preferences unreadable, unknown pack, invalid pack file, a value neither the settings nor the pack give)
 * `MarketUnresolvedError` is thrown and the caller skips the market-dependent step for this round. It never falls back
 * to the generic pack: that would switch the language step off and clear every deduction.
 */
import fs from "node:fs";
import path from "node:path";

import { ConfigError, firstConfigProblem } from "@/lib/config/errors";
import { loadConfig, parseConfigText } from "@/lib/config/load";
import { getProfileExampleDir } from "@/lib/config/paths";

import { GENERIC_PACK_ID, loadPack, type Pack } from "./load";
import type { MarketSettings } from "./schema";
import type { Market } from "./types";

export class MarketUnresolvedError extends Error {
  /** One line for people (no file contents). */
  readonly reason: string;
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`market cannot be resolved: ${reason}`, options);
    this.name = "MarketUnresolvedError";
    this.reason = reason;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const unique = <T>(...lists: ReadonlyArray<readonly T[]>): T[] => [...new Set(lists.flat())];

/** The market of these settings with these packs (pure apart from `loader`). */
export function buildMarket(settings: MarketSettings, generic: Pack, pack: Pack): Market {
  const meta = pack.meta;
  const country = settings.country ?? meta.country;
  const currency = settings.currency ?? meta.currency;
  const homeLanguage = settings.home_language ?? meta.language;
  if (country === undefined) throw new MarketUnresolvedError(`pack "${meta.id}" names no country: set market.country`);
  if (currency === undefined) throw new MarketUnresolvedError(`pack "${meta.id}" names no currency: set market.currency`);
  if (homeLanguage === undefined) throw new MarketUnresolvedError(`pack "${meta.id}" names no language: set market.home_language`);

  const sameAsPack = pack === generic ? [] : [pack];
  const countries = [...generic.geography.countries, ...sameAsPack.flatMap((p) => p.geography.countries)];
  const home = countries.find((c) => c.code === country);
  if (home === undefined) throw new MarketUnresolvedError(`country ${country} is not in the country table`);
  const regions = { ...generic.geography.regions, ...Object.assign({}, ...sameAsPack.map((p) => p.geography.regions)) } as Market["regions"];
  const packRegion = meta.region !== undefined && (meta.country === undefined || meta.country === country) ? meta.region : undefined;
  const homeRegion = packRegion ?? Object.entries(regions).find(([, region]) => region.countries.includes(country))?.[0] ?? null;

  const requirement = pack.language.requirement;
  const language = requirement !== undefined && meta.language !== undefined && meta.language === homeLanguage ? { code: homeLanguage, requirement } : null;

  const resolveWorld = pack.geography.resolve_world_countries ?? generic.geography.resolve_world_countries ?? true;
  return deepFreeze({
    packId: meta.id,
    packName: meta.name,
    country,
    countryName: home.name,
    currency,
    homeLanguage,
    locale: meta.locale !== undefined && meta.country === country && meta.language === homeLanguage ? meta.locale : `${homeLanguage}-${country}`,
    homeRegion,
    countries,
    regions,
    cities: { ...generic.geography.cities, ...Object.assign({}, ...sameAsPack.map((p) => p.geography.cities)) },
    subdivisionCodes: { ...generic.geography.subdivision_codes, ...Object.assign({}, ...sameAsPack.map((p) => p.geography.subdivision_codes)) },
    nonCityLabels: unique(generic.geography.non_city_labels, ...sameAsPack.map((p) => p.geography.non_city_labels)),
    nonCityWords: unique(generic.geography.non_city_words, ...sameAsPack.map((p) => p.geography.non_city_words)),
    transliterations: { ...generic.geography.transliterations, ...Object.assign({}, ...sameAsPack.map((p) => p.geography.transliterations)) },
    resolveWorldCountries: resolveWorld,
    language,
    defaultChannels: [...meta.default_channels],
  });
}

/** The two packs of a market: the generic pack and the market's own (the same object when the market is generic). */
export function loadMarketPacks(packId: string, loader: (id: string) => Pack = loadPack): { generic: Pack; pack: Pack } {
  try {
    const generic = loader(GENERIC_PACK_ID);
    return { generic, pack: packId === GENERIC_PACK_ID ? generic : loader(packId) };
  } catch (error) {
    if (error instanceof ConfigError) throw new MarketUnresolvedError(error.kind === "missing" ? `market pack "${error.configName}" not found` : firstConfigProblem(error), { cause: error });
    throw error;
  }
}

export interface MarketSettingsProblem {
  field: "pack" | "country" | "currency" | "home_language";
  /** `missing`: neither the settings nor the pack give a value; `unknown`: no such pack / country; `invalid`: the pack's files are broken. */
  problem: "missing" | "unknown" | "invalid";
  /** One line for people (`invalid` only). */
  detail?: string;
}

/** What keeps these settings from resolving, field by field (empty = they resolve). For the /me form before it saves. */
export function marketSettingsProblems(settings: MarketSettings, loader: (id: string) => Pack = loadPack): MarketSettingsProblem[] {
  let packs: { generic: Pack; pack: Pack };
  try {
    packs = loadMarketPacks(settings.pack, loader);
  } catch (error) {
    const cause = error instanceof MarketUnresolvedError ? error.cause : undefined;
    if (cause instanceof ConfigError && cause.kind === "missing") return [{ field: "pack", problem: "unknown" }];
    return [{ field: "pack", problem: "invalid", detail: error instanceof MarketUnresolvedError ? error.reason : String(error) }];
  }
  const meta = packs.pack.meta;
  const problems: MarketSettingsProblem[] = [];
  const country = settings.country ?? meta.country;
  if (country === undefined) problems.push({ field: "country", problem: "missing" });
  else if (![...packs.generic.geography.countries, ...packs.pack.geography.countries].some((c) => c.code === country)) problems.push({ field: "country", problem: "unknown" });
  if ((settings.currency ?? meta.currency) === undefined) problems.push({ field: "currency", problem: "missing" });
  if ((settings.home_language ?? meta.language) === undefined) problems.push({ field: "home_language", problem: "missing" });
  return problems;
}

const cache = new Map<string, { generic: Pack; pack: Pack; market: Market }>();

/** The market of these settings (cached while the settings and both packs are unchanged). Throws MarketUnresolvedError. */
export function resolveMarket(settings: MarketSettings, loader: (id: string) => Pack = loadPack): Market {
  const { generic, pack } = loadMarketPacks(settings.pack, loader);
  const key = JSON.stringify([settings.pack, settings.country ?? null, settings.currency ?? null, settings.home_language ?? null]);
  const hit = cache.get(key);
  if (hit && hit.generic === generic && hit.pack === pack) return hit.market;
  const market = buildMarket(settings, generic, pack);
  cache.set(key, { generic, pack, market });
  return market;
}

/**
 * preferences.yaml `market`: the saved profile, or its template in memory while the file is missing. Never creates
 * profile files. Throws MarketUnresolvedError when it cannot be read.
 */
export function readMarketSettings(): MarketSettings {
  try {
    return loadConfig("preferences").market;
  } catch (error) {
    if (error instanceof ConfigError && error.kind === "missing") {
      const template = path.join(getProfileExampleDir(), "preferences.yaml");
      try {
        const text = fs.readFileSync(/*turbopackIgnore: true*/ template, "utf8");
        return parseConfigText("preferences", text, template).market;
      } catch (inner) {
        throw new MarketUnresolvedError("preferences.yaml is missing and its template cannot be read", { cause: inner });
      }
    }
    if (error instanceof ConfigError) throw new MarketUnresolvedError(`preferences.yaml: ${firstConfigProblem(error)}`, { cause: error });
    throw error;
  }
}

/** The market of the current preferences. Throws MarketUnresolvedError (see the module comment). */
export function loadMarket(): Market {
  return resolveMarket(readMarketSettings());
}

export function resetMarketCache(): void {
  cache.clear();
}

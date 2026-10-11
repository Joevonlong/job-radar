/**
 * The remote scope (search.yaml / preferences.yaml `remote_scope`): `none`, `home_country`, `worldwide` or
 * `{ region: [eu | ISO …] }`. Pure helpers: the countries a scope covers, the location texts that name it as a whole,
 * a stable key (query ids), the old values (`eu_hire_in_de`, `eu_any`) and the location a channel searches with.
 */
import type { RemoteScopeValue } from "./schema";
import type { Market } from "./types";

/** The remote scope without `none` (what a remote query carries). */
export type ActiveRemoteScope = Exclude<RemoteScopeValue, "none">;

/** The keys of a channel's `remote_locations` block. */
export const REMOTE_LOCATION_KEYS = ["home_country", "region", "worldwide"] as const;
export type RemoteLocationKey = (typeof REMOTE_LOCATION_KEYS)[number];

/** Values before the market packs -> the new ones. Germany was the only market: `eu_hire_in_de` is the home country. */
export const LEGACY_REMOTE_SCOPES = { eu_hire_in_de: "home_country", eu_any: { region: ["eu"] } } as const;

/** The new value of an old one (`eu_any` -> `{ region: [eu] }`); anything else unchanged. */
export function migrateRemoteScope(value: unknown): unknown {
  if (value === "eu_hire_in_de") return LEGACY_REMOTE_SCOPES.eu_hire_in_de;
  if (value === "eu_any") return { region: [...LEGACY_REMOTE_SCOPES.eu_any.region] };
  return value;
}

/** A stable text for a scope: `none`, `home_country`, `worldwide`, `region:eu,CH` (query ids, select values, logs). */
export function remoteScopeKey(scope: RemoteScopeValue): string {
  return typeof scope === "string" ? scope : `region:${scope.region.join(",")}`;
}

/** The scope of a key made by `remoteScopeKey`, or null when it is not one. */
export function parseRemoteScopeKey(key: string): RemoteScopeValue | null {
  if (key === "none" || key === "home_country" || key === "worldwide") return key;
  const m = /^region:(.+)$/.exec(key);
  if (!m?.[1]) return null;
  const region = m[1].split(",").map((t) => t.trim()).filter((t) => t !== "");
  return region.length > 0 && region.every((t) => /^(?:[a-z][a-z0-9_]{1,31}|[A-Z]{2})$/.test(t)) ? { region } : null;
}

export const isRegionScope = (scope: RemoteScopeValue): scope is { region: string[] } => typeof scope === "object";

/** The key of a channel's `remote_locations` block for a scope. */
export function remoteLocationKey(scope: ActiveRemoteScope): RemoteLocationKey {
  return typeof scope === "string" ? scope : "region";
}

/** Countries of a region token: a named region's countries, or the country itself (ISO code). Unknown region: none. */
export function regionCountries(token: string, market: Pick<Market, "regions">): string[] {
  if (/^[A-Z]{2}$/.test(token)) return [token];
  return [...(market.regions[token]?.countries ?? [])];
}

/** The countries a scope covers; null = every country (`worldwide`). `none` covers none. */
export function scopeCountries(scope: RemoteScopeValue, market: Pick<Market, "country" | "regions">): ReadonlySet<string> | null {
  if (scope === "worldwide") return null;
  if (scope === "none") return new Set();
  if (scope === "home_country") return new Set([market.country]);
  return new Set(scope.region.flatMap((token) => regionCountries(token, market)));
}

/**
 * Location-text patterns that name the scope as a whole ("EU", "Europe", "EMEA"): the home region's for `home_country`
 * (a remote job "anywhere in the EU" hires in Germany too), the named regions' for a region scope.
 */
export function scopeWidePatterns(scope: RemoteScopeValue, market: Pick<Market, "homeRegion" | "regions">): string[] {
  if (scope === "none" || scope === "worldwide") return [];
  const regions = scope === "home_country" ? (market.homeRegion === null ? [] : [market.homeRegion]) : scope.region;
  return [...new Set(regions.flatMap((token) => market.regions[token]?.patterns ?? []))];
}

/** English name of a region token ("European Union", "Switzerland"), the token itself when unknown. */
export function regionTokenName(token: string, market: Pick<Market, "regions" | "countries">): string {
  if (/^[A-Z]{2}$/.test(token)) return market.countries.find((c) => c.code === token)?.name ?? token;
  return market.regions[token]?.name ?? token;
}

/**
 * The location text a channel searches a remote query with: the channel's `remote_locations` value for the scope when
 * it has one (an empty text only with `emptyMeansNoLocation`: jobspy then searches without a location), else the market's (the home country's English name,
 * the region's name, "Worldwide").
 */
export function remoteLocationFor(
  scope: ActiveRemoteScope,
  block: Partial<Record<RemoteLocationKey, string>> | undefined,
  market: Pick<Market, "countryName" | "regions" | "countries">,
  options: { worldwideText?: string; emptyMeansNoLocation?: boolean } = {},
): string {
  const configured = block?.[remoteLocationKey(scope)]?.trim();
  if (configured !== undefined && (configured !== "" || options.emptyMeansNoLocation === true)) return configured;
  const worldwideText = options.worldwideText ?? "Worldwide";
  if (scope === "worldwide") return worldwideText;
  if (scope === "home_country") return market.countryName;
  return scope.region.map((token) => regionTokenName(token, market)).join(", ");
}

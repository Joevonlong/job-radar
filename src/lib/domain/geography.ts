import type { JobLocation } from "./types";

export function locationsInCountry(locations: JobLocation[], countryCode?: string): JobLocation[] {
  if (!countryCode) return locations;
  return locations.filter((location) => location.countryCode === countryCode);
}

export function preferredLocationLabels(locations: JobLocation[], countryCode?: string, limit = 2): string[] {
  const scoped = locationsInCountry(locations, countryCode);
  const preferred = scoped.length ? scoped : locations;
  return preferred.slice(0, Math.max(0, limit)).map((location) => location.city ?? location.label);
}

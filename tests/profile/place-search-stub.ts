/** A stand-in for `/api/places` in component tests: the given candidates whose label starts with `q`, and the requests seen. */
import { vi } from "vitest";

import { placeKey, type Place as Geoname } from "@/lib/market/geo/dictionary";
import type { PlaceCandidate } from "@/lib/market/places";

export function geoname(id: number, kind: Geoname["kind"], name: string, countryCode: string, countryName: string, admin1: string | null = null): Geoname {
  return { id, kind, name, names: { en: name, de: null, zh: null }, localName: null, searchName: name, countryCode, countryName, admin1, population: 100_000, spellings: [name] };
}

export function candidate(record: Geoname, place = record.name): PlaceCandidate {
  return { id: record.id, kind: record.kind, place, label: record.name, detail: record.kind === "city" ? [record.admin1, record.countryName].filter(Boolean).join(", ") : "", record };
}

export function stubPlaceSearch(candidates: readonly PlaceCandidate[]): { requests: URLSearchParams[] } {
  const requests: URLSearchParams[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      requests.push(params);
      const typed = placeKey(params.get("q") ?? "");
      const kinds = params.get("kinds") === "city" ? ["city"] : ["city", "country"];
      const found = candidates.filter((c) => kinds.includes(c.kind) && placeKey(c.label).startsWith(typed));
      return new Response(JSON.stringify({ candidates: found }), { headers: { "Content-Type": "application/json" } });
    }),
  );
  return { requests };
}

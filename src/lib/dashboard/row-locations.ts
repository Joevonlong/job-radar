import { foldText, wholeWordPattern } from "@/lib/filter/rules";

/**
 * The places a list row shows: wanted ones first (cities of preferences.yaml `locations` with their
 * spellings and metro towns, see `targetPlaceNames`), then the rest in their stored order, at most `max`.
 * `more` counts the distinct places left out ("+N"). A multi-site posting thus lists Berlin / München
 * before Tallinn / Dublin instead of dropping them behind the first three.
 */
export function pickRowLocations(
  locations: readonly { city: string | null; label: string }[],
  places: readonly string[],
  max: number,
): { shown: string[]; more: number } {
  const patterns = places.map((name) => wholeWordPattern(foldText(name)));
  const entries = new Map<string, boolean>();
  for (const location of locations) {
    const name = location.city ?? location.label;
    if (entries.has(name)) continue;
    const text = [foldText(location.city ?? ""), foldText(location.label)];
    entries.set(name, text.some((value) => value !== "" && patterns.some((p) => p.test(value))));
  }
  const names = [...entries.keys()];
  const ordered = [...names.filter((n) => entries.get(n)), ...names.filter((n) => !entries.get(n))];
  return { shown: ordered.slice(0, max), more: Math.max(0, ordered.length - max) };
}

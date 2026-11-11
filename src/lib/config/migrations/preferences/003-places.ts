import type { Document } from "yaml";

import { normalizePlaces } from "@/lib/market/places";

import type { ConfigMigration } from "../types";
import { deleteKey, insertAfter, renameKey, setValue, valueAt } from "../edit";

const WORLDWIDE_PLACE = "Worldwide";

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()) : []);

/** The remote-only places of an old `remote_scope`, tokens as written. `home_country` and `none` add none. */
function scopePlaces(scope: unknown): string[] {
  if (scope === "worldwide") return [WORLDWIDE_PLACE];
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) return [];
  return strings((scope as { region?: unknown }).region);
}

/**
 * preferences.yaml 2 -> 3: one list of places.
 *
 * - The first of `locations` is `home_city`; the others are places with `relocate: true`.
 * - `remote_scope`: `home_country` adds nothing, its tokens and `worldwide` become remote-only places, `none` takes `remote`
 *   out of `workplace` unless it is the only value.
 * - The list goes through `normalizePlaces`, as every load does: a place in both keys is one ✈ entry.
 *
 * Reads nothing but the file: which country a place lies in is worked out when the place is read.
 */
export const preferences003: ConfigMigration = {
  from: 2,
  to: 3,
  description: "places: locations and remote_scope -> home_city and places",
  migrate(doc: Document) {
    const scope = valueAt(doc, ["remote_scope"]);
    const [homeCity = null, ...others] = strings(valueAt(doc, ["locations"]));
    const entries = [...others.map((place) => ({ place, relocate: true })), ...scopePlaces(scope).map((place) => ({ place, relocate: false }))];
    const { places } = normalizePlaces({ home_city: homeCity ?? "", places: entries });

    if (scope === "none") {
      const workplace = strings(valueAt(doc, ["workplace"]));
      const rest = workplace.filter((kind) => kind !== "remote");
      if (rest.length > 0 && rest.length < workplace.length) setValue(doc, ["workplace"], rest);
    }

    if (renameKey(doc, [], "locations", "home_city")) setValue(doc, ["home_city"], homeCity);
    else insertAfter(doc, [], "target_titles", "home_city", homeCity);
    insertAfter(doc, [], "home_city", "places", places, "Other places a job can be based. relocate: true = I'd move here; false = remote only.");
    deleteKey(doc, [], "remote_scope");
  },
};

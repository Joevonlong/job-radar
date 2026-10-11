/**
 * How the target titles of the setup land in search.yaml `keyword_groups`. Pure (the targets step previews the
 * result in the browser and the server applies the same function).
 *
 * - `keyword_groups` still equals the shipped default: the whole map is replaced by `{ targets: [...] }` (the example
 *   groups are someone else's search).
 * - The user changed the groups: only the `targets` group is added or replaced; every other group stays.
 */
import { isDeepStrictEqual } from "./deep-equal";

export const TARGETS_GROUP = "targets";

export type KeywordGroups = Readonly<Record<string, readonly string[]>>;

export interface KeywordPlan {
  /** `replace`: the groups were the shipped default and are replaced; `merge`: only `targets` is added / replaced; `none`: no titles, nothing changes. */
  mode: "replace" | "merge" | "none";
  groups: Record<string, string[]>;
}

/** Trimmed, non-empty, first occurrence wins (case-insensitive). */
export function cleanTitles(titles: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of titles) {
    const title = raw.trim();
    const key = title.toLowerCase();
    if (title === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(title);
  }
  return out;
}

function copy(groups: KeywordGroups): Record<string, string[]> {
  return Object.fromEntries(Object.entries(groups).map(([id, terms]) => [id, [...terms]]));
}

/** The keyword groups after saving `titles` (see the module comment). `shippedDefault` null = unknown (never replaced). */
export function planKeywordGroups(current: KeywordGroups, shippedDefault: KeywordGroups | null, titles: readonly string[]): KeywordPlan {
  const terms = cleanTitles(titles);
  if (terms.length === 0) return { mode: "none", groups: copy(current) };
  if (shippedDefault !== null && isDeepStrictEqual(copy(current), copy(shippedDefault))) return { mode: "replace", groups: { [TARGETS_GROUP]: terms } };
  const groups = copy(current);
  groups[TARGETS_GROUP] = terms;
  return { mode: "merge", groups };
}

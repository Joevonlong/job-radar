/**
 * The overlay merge: the effective value of a config is the shipped value with the user's overlay laid over it, key by
 * key. Pure functions on plain parsed values (no `config_version`: callers strip it); nothing here reads files, and the
 * loader does not use it yet.
 *
 * Rules (one test each in `tests/config/merge.test.ts`):
 * - a mapping in both layers is merged key by key (shipped keys keep their order, keys only the overlay has follow);
 * - otherwise the overlay value wins: a scalar, `null` (an explicit value), a list (lists are replaced as a whole), or a
 *   value of a different type;
 * - `key: !unset` (`UNSET`) removes the key; on a key the shipped layer does not have it does nothing;
 * - a record registered as `whole` or `opaque` (`overlay-rules.ts`) is replaced as a whole; an `entries` record is a
 *   mapping like any other;
 * - a value that replaces (rather than merges) holds no markers: a marker inside it only drops its own key.
 *
 * The result never holds `UNSET` and shares nothing with the inputs, so it survives `structuredClone`.
 */
import type { KeyPath, ReplaceAt } from "./overlay-rules";
import { isUnset } from "./yaml-options";

export type PlainMap = Record<string, unknown>;

export function isPlainMap(value: unknown): value is PlainMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural equality of plain parsed values (mappings by key, lists by position). */
export function plainEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, index) => plainEqual(item, b[index]));
  if (isPlainMap(a)) {
    if (!isPlainMap(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && plainEqual(a[key], b[key]));
  }
  return Number.isNaN(a) && Number.isNaN(b);
}

/** A deep copy of a plain value with every `UNSET` key dropped (a replacing value carries no markers). */
export function withoutMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((item) => !isUnset(item)).map(withoutMarkers);
  if (isPlainMap(value)) {
    const out: PlainMap = {};
    for (const [key, child] of Object.entries(value)) if (!isUnset(child)) out[key] = withoutMarkers(child);
    return out;
  }
  return value;
}

export interface MergeOptions {
  /** Where a user value replaces the shipped one as a whole (`replaceRule(name)`); default: nowhere. */
  replaceAt?: ReplaceAt;
}

const NEVER: ReplaceAt = () => false;

/** True when the overlay merges with the shipped value at `path` key by key (both mappings, not a replaced record). */
export function mergesAt(shipped: unknown, overlay: unknown, path: KeyPath, replaceAt: ReplaceAt): boolean {
  return isPlainMap(shipped) && isPlainMap(overlay) && !replaceAt(path);
}

function mergeAt(shipped: unknown, overlay: unknown, path: KeyPath, replaceAt: ReplaceAt): unknown {
  if (overlay === undefined) return withoutMarkers(shipped);
  if (!mergesAt(shipped, overlay, path, replaceAt)) return withoutMarkers(overlay);
  const base = shipped as PlainMap;
  const top = overlay as PlainMap;
  const out: PlainMap = {};
  for (const key of Object.keys(base)) {
    if (!Object.hasOwn(top, key)) out[key] = withoutMarkers(base[key]);
    else if (!isUnset(top[key])) out[key] = mergeAt(base[key], top[key], [...path, key], replaceAt);
  }
  for (const key of Object.keys(top)) {
    if (Object.hasOwn(base, key) || isUnset(top[key])) continue;
    out[key] = withoutMarkers(top[key]);
  }
  return out;
}

/**
 * The effective value: `overlay` laid over `shipped`. `overlay` undefined (no user file) gives a copy of `shipped`.
 */
export function mergeLayers(shipped: unknown, overlay: unknown, options: MergeOptions = {}): unknown {
  return mergeAt(shipped, overlay, [], options.replaceAt ?? NEVER);
}

/** The value at a key path, or undefined when a key on the way is missing (or not a mapping). */
export function valueAt(value: unknown, path: KeyPath): unknown {
  let node = value;
  for (const key of path) {
    if (!isPlainMap(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

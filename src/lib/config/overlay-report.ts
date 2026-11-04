/**
 * What a user overlay holds, key by key, against the shipped value: the numbers behind `pnpm config:check` and the
 * doctor's `config.layers`. Pure functions on plain parsed values; nothing here reads or writes a file (a test keeps it so).
 *
 * - an override is a key the overlay sets (a list, a replaced record or a new mapping counts once, at its own path);
 * - an unset is `key: !unset`; it is invalid when the shipped layer has no such key (it does nothing);
 * - a pin is an override whose value equals the shipped one: harmless, kept on purpose, and it stops following the product.
 *
 * What is shown of an override is never its contents: a protected key (`protected-keys.ts`), or a value that holds one, has
 * nothing; numbers, booleans and short plain strings show; anything else shows its shape (`shownValue`).
 */
import { isPlainMap, mergesAt, plainEqual, withoutMarkers } from "./merge";
import { replaceRule, formatKeyPath, type ReplaceAt } from "./overlay-rules";
import { isProtectedPath, protectedValues } from "./protected-keys";
import type { ConfigName } from "./registry";
import { isUnset } from "./yaml-options";

export interface OverlayEntry {
  /** `a.b`, a key with a dot quoted (`formatKeyPath`). */
  path: string;
  kind: "override" | "unset";
  /** An override equal to the shipped value. */
  pin: boolean;
  /** An unset of a key the shipped layer does not have. */
  invalid: boolean;
  protected: boolean;
  /** The value for people, masked and shortened; null for an unset and for a protected key. */
  shown: string | null;
}

export interface OverlayCounts {
  overrides: number;
  unsets: number;
  pins: number;
  invalidUnsets: number;
}

const SHORT_STRING_MAX = 40;
/** A string that looks like a token: a known key prefix anywhere in it, or 20 or more characters without a break. */
const TOKEN_SHAPE = /sk-|ghp_|AKIA|xox|[A-Za-z0-9+/=_-]{20,}/i;

/**
 * An override's value for people. Only numbers, booleans, null and short plain strings are shown; a string with `://` or the
 * shape of a token, and every list or mapping, shows its shape (`(string, 48 chars)`, `(list, 3 items)`, `(map, 2 keys)`).
 */
export function shownValue(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean" || value === null) return JSON.stringify(value);
  if (typeof value === "string") return value.length <= SHORT_STRING_MAX && !value.includes("://") && !TOKEN_SHAPE.test(value) ? JSON.stringify(value) : `(string, ${value.length} chars)`;
  if (Array.isArray(value)) return `(list, ${value.length} item${value.length === 1 ? "" : "s"})`;
  if (isPlainMap(value)) return `(map, ${Object.keys(value).length} key${Object.keys(value).length === 1 ? "" : "s"})`;
  return "(value)";
}

/** Does the value at `path` hold a protected key, or sit inside a protected value? Then its contents are never shown. */
function holdsProtected(name: ConfigName, path: readonly string[], value: unknown): boolean {
  if (isProtectedPath(name, path.join("."))) return true;
  let wrapped: unknown = value;
  for (let i = path.length - 1; i >= 0; i--) wrapped = { [path[i] ?? ""]: wrapped };
  return protectedValues(name, wrapped).size > 0;
}

function walk(name: ConfigName, shipped: unknown, overlay: Record<string, unknown>, path: string[], replaceAt: ReplaceAt, out: OverlayEntry[]): void {
  for (const [key, child] of Object.entries(overlay)) {
    const at = [...path, key];
    const shippedChild = isPlainMap(shipped) && Object.hasOwn(shipped, key) ? shipped[key] : undefined;
    const label = formatKeyPath(at);
    if (isUnset(child)) {
      const isProtected = isProtectedPath(name, at.join("."));
      out.push({ path: label, kind: "unset", pin: false, invalid: shippedChild === undefined, protected: isProtected, shown: null });
      continue;
    }
    if (isPlainMap(child) && mergesAt(shippedChild, child, at, replaceAt)) {
      walk(name, shippedChild, child, at, replaceAt, out);
      continue;
    }
    const value = withoutMarkers(child);
    const isProtected = holdsProtected(name, at, value);
    out.push({
      path: label,
      kind: "override",
      pin: shippedChild !== undefined && plainEqual(value, shippedChild),
      invalid: false,
      protected: isProtected,
      shown: isProtected ? null : shownValue(value),
    });
  }
}

/** The entries of an overlay (without `config_version`, `UNSET` markers allowed) laid over the shipped value, in file order. */
export function overlayEntries(name: ConfigName, shipped: unknown, overlay: unknown): OverlayEntry[] {
  const out: OverlayEntry[] = [];
  if (isPlainMap(overlay)) walk(name, shipped, overlay, [], replaceRule(name), out);
  return out;
}

export function countOverlayEntries(entries: readonly OverlayEntry[]): OverlayCounts {
  return {
    overrides: entries.filter((entry) => entry.kind === "override").length,
    unsets: entries.filter((entry) => entry.kind === "unset").length,
    pins: entries.filter((entry) => entry.pin).length,
    invalidUnsets: entries.filter((entry) => entry.invalid).length,
  };
}

export interface ChangedDefault {
  path: string;
  change: "added" | "removed" | "changed";
  protected: boolean;
  /** The real shipped values (public defaults); null where there is none (the other side of an add or a removal) and for a protected key. */
  before: unknown;
  after: unknown;
  /** For a list or a mapping that changed: the items or keys added, removed and changed, as one line. */
  summary: string | null;
}

const json = (value: unknown): string => JSON.stringify(value) ?? String(value);

/** What differs between two lists or two mappings, as one line; null for any other pair of values. */
function summarise(was: unknown, now: unknown): string | null {
  if (Array.isArray(was) && Array.isArray(now)) {
    const removed = was.filter((item) => !now.some((other) => plainEqual(item, other)));
    const added = now.filter((item) => !was.some((other) => plainEqual(item, other)));
    const parts = [...(added.length > 0 ? [`added ${json(added)}`] : []), ...(removed.length > 0 ? [`removed ${json(removed)}`] : [])];
    return parts.length > 0 ? parts.join("; ") : "same items, other order";
  }
  if (isPlainMap(was) && isPlainMap(now)) {
    const keys = [...new Set([...Object.keys(was), ...Object.keys(now)])];
    const parts = keys.flatMap((key) => {
      if (!Object.hasOwn(was, key)) return [`+${key}=${json(now[key])}`];
      if (!Object.hasOwn(now, key)) return [`-${key}`];
      return plainEqual(was[key], now[key]) ? [] : [`~${key}: ${json(was[key])} -> ${json(now[key])}`];
    });
    return parts.join("; ");
  }
  return null;
}

function leaves(value: unknown, path: string[], replaceAt: ReplaceAt, out: Map<string, unknown>): void {
  if (path.length === 0 && isPlainMap(value) && Object.keys(value).length === 0) return; // no file / an empty one: no keys
  if (isPlainMap(value) && !replaceAt(path) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) leaves(child, [...path, key], replaceAt, out);
    return;
  }
  out.set(JSON.stringify(path), value);
}

/** The keys whose shipped value differs between two shipped values of a config (migrated, no `config_version`). */
export function changedDefaults(name: ConfigName, before: unknown, after: unknown): ChangedDefault[] {
  const replaceAt = replaceRule(name);
  const was = new Map<string, unknown>();
  const now = new Map<string, unknown>();
  leaves(before, [], replaceAt, was);
  leaves(after, [], replaceAt, now);
  const out: ChangedDefault[] = [];
  for (const key of new Set([...was.keys(), ...now.keys()])) {
    const hadIt = was.has(key);
    const hasIt = now.has(key);
    if (hadIt && hasIt && plainEqual(was.get(key), now.get(key))) continue;
    const path = JSON.parse(key) as string[];
    const isProtected = holdsProtected(name, path, was.get(key)) || holdsProtected(name, path, now.get(key));
    out.push({
      path: formatKeyPath(path),
      change: !hadIt ? "added" : !hasIt ? "removed" : "changed",
      protected: isProtected,
      before: hadIt && !isProtected ? was.get(key) : null,
      after: hasIt && !isProtected ? now.get(key) : null,
      summary: isProtected || !hadIt || !hasIt ? null : summarise(was.get(key), now.get(key)),
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

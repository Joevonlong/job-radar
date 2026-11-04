/**
 * What a user overlay holds, key by key, against the shipped value: the numbers behind `pnpm config:check` and the
 * doctor's `config.layers`. Pure functions on plain parsed values; nothing here reads or writes a file (a test keeps it so).
 *
 * - an override is a key the overlay sets (a list, a replaced record or a new mapping counts once, at its own path);
 * - an unset is `key: !unset`; it is invalid when the shipped layer has no such key (it does nothing);
 * - a pin is an override whose value equals the shipped one: harmless, kept on purpose, and it stops following the product.
 *
 * A value is never kept unmasked here: a protected key (`protected-keys.ts`) has no value at all, any other value is the
 * text of its JSON with URL credentials masked (`maskCredentialsInText`).
 */
import { maskCredentialsInText } from "@/lib/sources/registry/import";

import { isPlainMap, mergesAt, plainEqual, withoutMarkers } from "./merge";
import { replaceRule, formatKeyPath, type ReplaceAt } from "./overlay-rules";
import { isProtectedPath } from "./protected-keys";
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

const SHOWN_LIMIT = 100;

/** A value as one masked, shortened line (JSON, credentials of URLs replaced). */
export function shownValue(value: unknown): string {
  const text = maskCredentialsInText(JSON.stringify(value) ?? String(value));
  return text.length > SHOWN_LIMIT ? `${text.slice(0, SHOWN_LIMIT - 1)}…` : text;
}

function walk(name: ConfigName, shipped: unknown, overlay: Record<string, unknown>, path: string[], replaceAt: ReplaceAt, out: OverlayEntry[]): void {
  for (const [key, child] of Object.entries(overlay)) {
    const at = [...path, key];
    const shippedChild = isPlainMap(shipped) && Object.hasOwn(shipped, key) ? shipped[key] : undefined;
    const label = formatKeyPath(at);
    const isProtected = isProtectedPath(name, at.join("."));
    if (isUnset(child)) {
      out.push({ path: label, kind: "unset", pin: false, invalid: shippedChild === undefined, protected: isProtected, shown: null });
      continue;
    }
    if (isPlainMap(child) && mergesAt(shippedChild, child, at, replaceAt)) {
      walk(name, shippedChild, child, at, replaceAt, out);
      continue;
    }
    const value = withoutMarkers(child);
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
  /** Masked values for people; null where there is none (the other side of an add or a removal) and for a protected key. */
  before: string | null;
  after: string | null;
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
    const isProtected = isProtectedPath(name, path.join("."));
    out.push({
      path: formatKeyPath(path),
      change: !hadIt ? "added" : !hasIt ? "removed" : "changed",
      protected: isProtected,
      before: hadIt && !isProtected ? shownValue(was.get(key)) : null,
      after: hasIt && !isProtected ? shownValue(now.get(key)) : null,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

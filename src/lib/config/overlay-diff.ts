/**
 * What a save changes in an overlay (the pinned-key rule). Given the shipped value S, the current overlay O (so the
 * effective value E = mergeLayers(S, O)) and the value V the user saves, only the paths where E and V differ are touched:
 *
 * - V differs from what the shipped layer gives at the path → the overlay gets V's value;
 * - V is back to what the shipped layer gives → the key leaves the overlay (a mapping it empties goes with it);
 * - V dropped a key the shipped layer has → `key: !unset`; a key only the overlay had → it leaves the overlay;
 * - an explicit `null` is a value like any other.
 *
 * Everything else in the overlay stays, including a hand-written key equal to the shipped value; a save without a
 * change yields no edits, so the file stays byte for byte. The repair entry (`repairOverlayEdits`) diffs a complete value
 * against the shipped one with no overlay at all: a broken file is not looked at.
 *
 * Edits are plain data (no `UNSET` symbol), so they survive `structuredClone`; `applyOverlayEdits` applies them to a
 * plain overlay value, and the writer (later) applies the same edits to the overlay document to keep its comments.
 */
import { isPlainMap, mergeLayers, plainEqual, withoutMarkers, type PlainMap } from "./merge";
import type { ReplaceAt } from "./overlay-rules";
import { UNSET } from "./yaml-options";

export type OverlayEdit =
  /** Write this value (a mapping here replaces what the overlay had at the path; it never holds markers). */
  | { op: "set"; path: string[]; value: unknown }
  /** Drop the key from the overlay (the shipped value, if any, shows through). */
  | { op: "remove"; path: string[] }
  /** Write `key: !unset`. */
  | { op: "unset"; path: string[] };

export interface DiffOverlayInput {
  /** The shipped value (migrated, without `config_version`). */
  shipped: unknown;
  /** The current overlay (may hold `UNSET`); undefined or `{}` when there is none. */
  overlay: unknown;
  /** The complete value to save. */
  value: unknown;
  replaceAt?: ReplaceAt;
}

const NEVER: ReplaceAt = () => false;

/**
 * @param partner what the overlay merges with at `path` (undefined: nothing, the overlay value stands alone)
 * @param overlay the overlay node at `path`
 * @param effective E at `path`
 */
function walk(partner: unknown, overlay: unknown, effective: unknown, value: unknown, path: string[], replaceAt: ReplaceAt, edits: OverlayEdit[]): void {
  if (plainEqual(effective, value)) return;
  if (isPlainMap(effective) && isPlainMap(value) && !replaceAt(path)) {
    // E is a mapping, so the overlay node here is a mapping or absent (then E is the shipped mapping itself)
    const merges = isPlainMap(partner) && !replaceAt(path);
    const overlayMap = isPlainMap(overlay) ? overlay : undefined;
    const start = edits.length;
    const keys = [...Object.keys(effective), ...Object.keys(value).filter((key) => !Object.hasOwn(effective, key))];
    for (const key of keys) {
      const childPartner = merges ? (partner as PlainMap)[key] : undefined;
      walk(childPartner, overlayMap?.[key], effective[key], value[key], [...path, key], replaceAt, edits);
    }
    // every overlay key here went away: drop the (now empty) mapping too, the shipped mapping shows through unchanged
    if (merges && overlayMap && path.length > 0) {
      const added = edits.slice(start);
      const overlayKeys = Object.keys(overlayMap);
      const emptied =
        overlayKeys.length > 0 &&
        added.length === overlayKeys.length &&
        added.every((edit) => edit.op === "remove" && edit.path.length === path.length + 1 && overlayKeys.includes(edit.path[path.length] ?? ""));
      if (emptied) edits.splice(start, added.length, { op: "remove", path });
    }
    return;
  }
  if (value === undefined) {
    edits.push(partner === undefined ? { op: "remove", path } : { op: "unset", path });
    return;
  }
  if (partner !== undefined && plainEqual(partner, value)) {
    edits.push({ op: "remove", path });
    return;
  }
  if (isPlainMap(value) && isPlainMap(partner) && !replaceAt(path)) {
    // the overlay holds a marker or a non-mapping here: start an empty mapping (= the shipped mapping) and diff into it
    edits.push({ op: "set", path, value: {} });
    walk(partner, {}, withoutMarkers(partner), value, path, replaceAt, edits);
    return;
  }
  edits.push({ op: "set", path, value: withoutMarkers(value) });
}

/** The edits that turn the overlay into one whose effective value is `value` (see the module comment). */
export function diffOverlay(input: DiffOverlayInput): OverlayEdit[] {
  const replaceAt = input.replaceAt ?? NEVER;
  const effective = mergeLayers(input.shipped, input.overlay, { replaceAt });
  const edits: OverlayEdit[] = [];
  walk(input.shipped, input.overlay, effective, input.value, [], replaceAt, edits);
  return edits;
}

/**
 * The repair entry: the overlay for a complete value when the current file cannot be used (a syntax or schema error),
 * diffed against the shipped value alone. Applied to an empty overlay.
 */
export function repairOverlayEdits(shipped: unknown, value: unknown, replaceAt?: ReplaceAt): OverlayEdit[] {
  return diffOverlay({ shipped, overlay: {}, value, replaceAt });
}

/** A deep copy that keeps `UNSET` markers (which `structuredClone` refuses). */
export function cloneOverlay(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneOverlay);
  if (isPlainMap(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneOverlay(child)]));
  return value;
}

/** Apply edits to a plain overlay value (not changed); returns the new overlay, always a mapping. */
export function applyOverlayEdits(overlay: unknown, edits: readonly OverlayEdit[]): PlainMap {
  const root: PlainMap = isPlainMap(overlay) ? (cloneOverlay(overlay) as PlainMap) : {};
  for (const edit of edits) {
    const parentPath = edit.path.slice(0, -1);
    const key = edit.path.at(-1);
    if (key === undefined) continue;
    if (edit.op === "remove") {
      let node: unknown = root;
      for (const segment of parentPath) node = isPlainMap(node) ? node[segment] : undefined;
      if (isPlainMap(node)) delete node[key];
      continue;
    }
    let node: PlainMap = root;
    for (const segment of parentPath) {
      const child = node[segment];
      if (isPlainMap(child)) node = child;
      else {
        const created: PlainMap = {};
        node[segment] = created;
        node = created;
      }
    }
    node[key] = edit.op === "unset" ? UNSET : cloneOverlay(edit.value);
  }
  return root;
}

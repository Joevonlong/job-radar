/**
 * Small, comment-keeping edits of a parsed YAML document for config migrations. Every helper tolerates a
 * missing path (the user's file may lack keys the shipped default has) and edits nodes in place.
 */
import { isMap, isScalar, isSeq, type Document, type Pair, type YAMLMap, type YAMLSeq } from "yaml";

type Path = readonly string[];

/** The mapping node at `path` (the document root for `[]`), or null. */
export function mapAt(doc: Document, path: Path): YAMLMap | null {
  const node = path.length === 0 ? doc.contents : doc.getIn(path, true);
  return isMap(node) ? node : null;
}

export function seqAt(doc: Document, path: Path): YAMLSeq | null {
  const node = doc.getIn(path, true);
  return isSeq(node) ? node : null;
}

function pairOf(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((pair) => isScalar(pair.key) && pair.key.value === key) as Pair | undefined;
}

/** Rename a key of the mapping at `path` in place (value and comments kept). No-op when it is missing or `to` exists. */
export function renameKey(doc: Document, path: Path, from: string, to: string): boolean {
  const map = mapAt(doc, path);
  if (map === null || pairOf(map, to) !== undefined) return false;
  const pair = pairOf(map, from);
  if (pair === undefined || !isScalar(pair.key)) return false;
  pair.key.value = to;
  return true;
}

/** Set a scalar or collection value at `path` (created when missing). */
export function setValue(doc: Document, path: Path, value: unknown): void {
  const node = doc.getIn(path, true);
  if (isScalar(node) && (value === null || typeof value !== "object")) {
    node.value = value;
    return;
  }
  doc.setIn(path, doc.createNode(value));
}

/** The plain JS value at `path`, or undefined. */
export function valueAt(doc: Document, path: Path): unknown {
  const node = doc.getIn(path, true);
  if (node === undefined || node === null) return undefined;
  return isScalar(node) ? node.value : (node as { toJSON(): unknown }).toJSON();
}

/**
 * Remove the scalar items of the list at `path` that `drop` says (the user's other entries stay, in their order).
 * Returns how many were removed.
 */
export function removeListItems(doc: Document, path: Path, drop: (value: unknown) => boolean): number {
  const seq = seqAt(doc, path);
  if (seq === null) return 0;
  const before = seq.items.length;
  seq.items = seq.items.filter((item) => !(isScalar(item) && drop(item.value)));
  return before - seq.items.length;
}

/** Remove the entries of the mapping at `path` that `drop` says (by key and plain value). */
export function removeMapEntries(doc: Document, path: Path, drop: (key: string, value: unknown) => boolean): number {
  const map = mapAt(doc, path);
  if (map === null) return 0;
  const before = map.items.length;
  map.items = map.items.filter((pair) => {
    if (!isScalar(pair.key)) return true;
    const value: unknown = pair.value === null || pair.value === undefined ? pair.value : isScalar(pair.value) ? pair.value.value : (pair.value as { toJSON(): unknown }).toJSON();
    return !drop(String(pair.key.value), value);
  });
  return before - map.items.length;
}

/** Delete a key of the mapping at `path`. */
export function deleteKey(doc: Document, path: Path, key: string): boolean {
  const map = mapAt(doc, path);
  if (map === null || pairOf(map, key) === undefined) return false;
  map.delete(key);
  return true;
}

/** Add a line to the comment above a key (`# …`). */
export function noteAbove(doc: Document, path: Path, key: string, text: string): void {
  const map = mapAt(doc, path);
  const pair = map === null ? undefined : pairOf(map, key);
  if (pair === undefined || !isScalar(pair.key)) return;
  const current = pair.key.commentBefore;
  pair.key.commentBefore = current ? `${current}\n ${text}` : ` ${text}`;
}

/** Insert a key into the mapping at `path` right after `afterKey` (at the end when that is missing). No-op when it exists or the mapping does not. */
export function insertAfter(doc: Document, path: Path, afterKey: string, key: string, value: unknown, comment?: string): void {
  const map = mapAt(doc, path);
  if (map === null || pairOf(map, key) !== undefined) return;
  const node = doc.createNode(value);
  if (isSeq(node)) node.flow = true;
  const pair = doc.createPair(key, node);
  if (comment !== undefined) (pair.key as { commentBefore?: string }).commentBefore = ` ${comment}`;
  const index = map.items.findIndex((item) => isScalar(item.key) && item.key.value === afterKey);
  if (index < 0) map.items.push(pair);
  else map.items.splice(index + 1, 0, pair);
}

/** Insert a key into the mapping at `path` right before `beforeKey` (at the end when that is missing). No-op when it exists. */
export function insertBefore(doc: Document, path: Path, beforeKey: string, key: string, value: unknown, comment?: string): void {
  const map = mapAt(doc, path);
  if (map === null || pairOf(map, key) !== undefined) return;
  const pair = doc.createPair(key, value);
  if (comment !== undefined) (pair.key as { commentBefore?: string }).commentBefore = ` ${comment}`;
  const index = map.items.findIndex((item) => isScalar(item.key) && item.key.value === beforeKey);
  if (index < 0) map.items.push(pair);
  else map.items.splice(index, 0, pair);
}

/**
 * Insert a key as the first one of the root mapping; a comment written above the old first key (the file's header)
 * moves up with it, so it stays on top. No-op when the key exists.
 */
export function insertFirst(doc: Document, key: string, value: unknown, comment?: string): void {
  const map = mapAt(doc, []);
  if (map === null || pairOf(map, key) !== undefined) return;
  const pair = doc.createPair(key, value);
  const first = map.items[0];
  const header = first && isScalar(first.key) ? first.key.commentBefore : undefined;
  if (first && isScalar(first.key) && header) first.key.commentBefore = undefined;
  if (first && isScalar(first.key) && first.key.spaceBefore) first.key.spaceBefore = false;
  const keyNode = pair.key as { commentBefore?: string; spaceBefore?: boolean };
  keyNode.commentBefore = header ?? undefined;
  // the explanation goes inside the new block, above its first key (the header comment stays on top of the file)
  const firstInner = isMap(pair.value) ? pair.value.items[0] : undefined;
  if (comment !== undefined && firstInner && isScalar(firstInner.key)) firstInner.key.commentBefore = ` ${comment}`;
  map.items.unshift(pair);
  if (first && isScalar(first.key)) first.key.spaceBefore = true;
}

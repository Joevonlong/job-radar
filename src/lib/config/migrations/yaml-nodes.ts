/**
 * Small helpers for config migrations that move YAML nodes around. Moving a pair keeps the comments written
 * above and beside its key, which is what a migration has to preserve.
 */
import { isMap, isScalar, type Document, type Pair, type YAMLMap } from "yaml";

/** The key of a pair as text (null for a complex key). */
export function keyText(pair: Pair): string | null {
  if (isScalar(pair.key)) return String(pair.key.value);
  return typeof pair.key === "string" ? pair.key : null;
}

/** The pair of `key` in a map, or undefined. */
export function pairOf(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((pair) => keyText(pair) === key);
}

/** Take the pair of `key` out of `map` (undefined when absent). */
export function takePair(map: YAMLMap, key: string): Pair | undefined {
  const index = map.items.findIndex((pair) => keyText(pair) === key);
  if (index === -1) return undefined;
  const [pair] = map.items.splice(index, 1);
  return pair;
}

/** Rename a key in place (its comments stay); false when the key is absent or the new one exists already. */
export function renameKey(map: YAMLMap, from: string, to: string): boolean {
  const pair = pairOf(map, from);
  if (!pair || pairOf(map, to)) return false;
  if (isScalar(pair.key)) pair.key.value = to;
  else pair.key = to;
  return true;
}

/** The comment written above a pair's key, and whether a blank line precedes it. */
export function keyComment(pair: Pair): { comment: string | null; space: boolean } {
  if (isScalar(pair.key)) return { comment: pair.key.commentBefore ?? null, space: pair.key.spaceBefore === true };
  return { comment: null, space: false };
}

/** The mapping value of `key`, or null when it is absent or not a mapping. */
export function mapOf(map: YAMLMap, key: string): YAMLMap | null {
  const value: unknown = map.get(key, true);
  return isMap(value) ? value : null;
}

/** A new pair `key: value` of the document. */
export function newPair(doc: Document, key: string, value: unknown): Pair {
  return doc.createPair(key, value);
}

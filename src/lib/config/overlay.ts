import { isDeepStrictEqual } from "node:util";

import { isMap, isScalar, type Document, type YAMLMap } from "yaml";

import { isPlainMap, mergeLayers, type PlainMap } from "./merge";
import { diffOverlay, type OverlayEdit } from "./overlay-diff";
import { replaceRule, type ReplaceAt } from "./overlay-rules";
import { configRegistry, type ConfigName } from "./registry";
import { UNSET } from "./yaml-options";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The one thing used of a zod schema: parsing. */
interface Parser {
  safeParse(input: unknown): { success: boolean; data?: unknown };
}

/**
 * Delete from `work` (in place) what the schema gives back by itself: a key `known` does not have is left out when the
 * schema still returns `expected` without it. Keys `known` has are never touched. A list item is looked into unless it is
 * one of `known`'s own items (the user's, by identity).
 */
function dropSchemaDefaults(schema: Parser, work: unknown, known: unknown, expected: unknown): void {
  const readsBack = (): boolean => {
    const result = schema.safeParse(work);
    return result.success && isDeepStrictEqual(result.data, expected);
  };
  const walk = (node: unknown, knownNode: unknown): void => {
    if (Array.isArray(node)) {
      const knownItems: readonly unknown[] = Array.isArray(knownNode) ? knownNode : [];
      for (const item of node) if (!knownItems.includes(item)) walk(item, {});
      return;
    }
    if (!isPlainObject(node)) return;
    const knownMap = isPlainObject(knownNode) ? knownNode : {};
    for (const key of Object.keys(node)) {
      if (Object.hasOwn(knownMap, key)) {
        walk(node[key], knownMap[key]);
        continue;
      }
      const child = node[key];
      delete node[key];
      if (readsBack()) continue;
      node[key] = child;
      walk(child, {});
    }
  };
  walk(work, known);
}

/**
 * The part of a validated config worth writing to a whole file. `value` is what the schema returned: it holds every
 * key, including the ones the schema filled in from its own defaults. A key the user's file does not have (`existing`,
 * the plain value of that file) is left out when the schema gives it back unchanged without it: it is a default, and a
 * default written into the file would pin the value, so a later change of the shipped default never reaches the user.
 *
 * Keys the file already has are never touched (the user's own, even when equal to the default). Lists are one value:
 * their items are not looked at. The result always parses back to exactly `value`; `value` itself is not changed.
 */
export function pruneRedundantKeys<T>(schema: Parser, value: T, existing: unknown): T {
  const work = structuredClone(value);
  const readsBack = (): boolean => {
    const result = schema.safeParse(work);
    return result.success && isDeepStrictEqual(result.data, value);
  };
  const walk = (node: unknown, known: unknown): void => {
    if (!isPlainObject(node)) return;
    const knownMap = isPlainObject(known) ? known : {};
    for (const key of Object.keys(node)) {
      if (Object.hasOwn(knownMap, key)) {
        walk(node[key], knownMap[key]);
        continue;
      }
      const child = node[key];
      delete node[key];
      if (readsBack()) continue;
      node[key] = child;
      walk(child, {});
    }
  };
  walk(work, existing);
  return work;
}

/**
 * What the saved value `value` (a schema output) means in terms of the raw merged value `raw` and its schema output
 * `parsed`: where the schema output did not change, the raw part stands (so a key the schema only filled in, or normalised,
 * does not count as a change). Raw parts are shared, not copied; new parts are copies.
 */
function reconcile(raw: unknown, parsed: unknown, value: unknown): unknown {
  if (parsed !== undefined && isDeepStrictEqual(parsed, value)) return raw;
  if (isPlainMap(value)) {
    const out: PlainMap = {};
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      const next = reconcile(isPlainMap(raw) ? raw[key] : undefined, isPlainMap(parsed) ? parsed[key] : undefined, child);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  if (Array.isArray(value)) {
    const rawItems: readonly unknown[] = Array.isArray(raw) ? raw : [];
    const parsedItems: readonly unknown[] = Array.isArray(parsed) ? parsed : [];
    return value.map((item: unknown) => {
      const same = parsedItems.findIndex((candidate) => isDeepStrictEqual(candidate, item));
      return same >= 0 && same < rawItems.length ? rawItems[same] : structuredClone(item);
    });
  }
  return value;
}

export interface OverlaySaveInput {
  /** The shipped value (migrated, without `config_version`). */
  shipped: unknown;
  /** The current overlay (may hold `UNSET`); `{}` when there is none. */
  overlay: unknown;
  /** The validated value to save. */
  value: unknown;
}

/**
 * The edits a save makes to an overlay: only the paths where the value differs from what the two layers give now (the
 * pinned-key rule, `overlay-diff.ts`). Values the schema filled in are not written, also not inside a replaced list or
 * a new record entry, so they keep following the schema.
 */
export function overlaySaveEdits(name: ConfigName, input: OverlaySaveInput): OverlayEdit[] {
  const schema = configRegistry[name].schema;
  const replaceAt = replaceRule(name);
  const effective = mergeLayers(input.shipped, input.overlay, { replaceAt });
  const parsed = schema.safeParse(effective);
  const target = reconcile(effective, parsed.success ? parsed.data : undefined, input.value);
  dropSchemaDefaults(schema, target, effective, input.value);
  return diffOverlay({ shipped: input.shipped, overlay: input.overlay, value: target, replaceAt });
}

/** The edits that write the complete value, schema defaults included: the fallback when the leaner edits do not read back. */
export function overlayFullEdits(name: ConfigName, input: OverlaySaveInput): OverlayEdit[] {
  return diffOverlay({ shipped: input.shipped, overlay: input.overlay, value: input.value, replaceAt: replaceRule(name) });
}

function pairOf(map: YAMLMap, key: string): YAMLMap["items"][number] | undefined {
  return map.items.find((pair) => String(isScalar(pair.key) ? pair.key.value : pair.key) === key);
}

/** How the writer puts a value in an existing node, keeping its comments (`write.ts`). */
export type SetNode = (doc: Document, current: unknown, value: unknown) => unknown;

/**
 * Apply edits to an overlay document in place, so comments and layout of what stays are kept. A mapping a removal empties
 * goes too (the shipped mapping shows through); a replaced record stays, because empty means something there.
 */
export function applyEditsToDocument(doc: Document, edits: readonly OverlayEdit[], replaceAt: ReplaceAt, setNode: SetNode): void {
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as Document["contents"];
  const root = doc.contents as YAMLMap;
  for (const edit of edits) {
    const key = edit.path.at(-1);
    if (key === undefined) continue;
    const parents = edit.path.slice(0, -1);
    if (edit.op === "remove") {
      const chain: YAMLMap[] = [root];
      for (const segment of parents) {
        const next = pairOf(chain.at(-1) as YAMLMap, segment)?.value;
        if (!isMap(next)) break;
        chain.push(next);
      }
      if (chain.length !== parents.length + 1) continue;
      const parent = chain.at(-1) as YAMLMap;
      const pair = pairOf(parent, key);
      if (pair) parent.items.splice(parent.items.indexOf(pair), 1);
      for (let depth = chain.length - 1; depth > 0; depth--) {
        const node = chain[depth] as YAMLMap;
        if (node.items.length > 0 || replaceAt(parents.slice(0, depth))) break;
        const above = chain[depth - 1] as YAMLMap;
        const holder = above.items.find((candidate) => candidate.value === node);
        if (holder) above.items.splice(above.items.indexOf(holder), 1);
      }
      continue;
    }
    let map = root;
    for (const segment of parents) {
      const pair = pairOf(map, segment);
      if (pair && isMap(pair.value)) {
        map = pair.value;
        continue;
      }
      const created = doc.createNode({}) as YAMLMap;
      if (pair) pair.value = created;
      else map.items.push(doc.createPair(segment, created));
      map = created;
    }
    const existing = pairOf(map, key);
    const node = edit.op === "unset" ? doc.createNode(UNSET) : existing ? setNode(doc, existing.value, edit.value) : doc.createNode(edit.value);
    if (existing) existing.value = node as typeof existing.value;
    else map.items.push(doc.createPair(key, node));
  }
}

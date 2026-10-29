/**
 * Render the merged document of a config: the shipped document with the overlay laid over it, node by node, so the
 * shipped comments stay and the user's values keep theirs. It is a document, not the zod output: a key that only the
 * schema's defaults fill in is not written. Used for the full export and, later, for `config:migrate --to-full`.
 * Not used by the loader yet.
 */
import { isAlias, isMap, isNode, isScalar, visit, type Document, type Node, type Pair, type YAMLMap } from "yaml";

import { CONFIG_VERSION_KEY, currentConfigVersion, stampConfigVersion } from "./migrations/version";
import { replaceRule, type ReplaceAt } from "./overlay-rules";
import type { ConfigName } from "./registry";
import { isUnset, stringifyConfigYaml } from "./yaml-options";

function keyOf(pair: Pair): string {
  return String(isScalar(pair.key) ? pair.key.value : pair.key);
}

function findPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((pair) => keyOf(pair) === key);
}

function holdsAlias(node: unknown): boolean {
  let found = false;
  visit(node as Node, {
    Alias() {
      found = true;
      return visit.BREAK;
    },
  });
  return found;
}

/** A copy of an overlay node for the target document: markers dropped, aliases resolved (their anchors stay behind). */
function copyNode(node: unknown, from: Document, into: Document): Node | null {
  if (!isNode(node)) return null;
  if (isAlias(node) || holdsAlias(node)) return into.createNode(node.toJS(from));
  const copy = node.clone() as Node;
  visit(copy, {
    Pair(_key, pair) {
      if (isScalar(pair.value) && isUnset(pair.value.value)) return visit.REMOVE;
      return undefined;
    },
  });
  return copy;
}

function overlayInto(target: YAMLMap, overlay: YAMLMap, path: string[], replaceAt: ReplaceAt, from: Document, into: Document): void {
  for (const pair of overlay.items) {
    const key = keyOf(pair);
    if (path.length === 0 && key === CONFIG_VERSION_KEY) continue;
    const childPath = [...path, key];
    const existing = findPair(target, key);
    if (isScalar(pair.value) && isUnset(pair.value.value)) {
      if (existing) target.items.splice(target.items.indexOf(existing), 1);
      continue;
    }
    if (existing && isMap(existing.value) && isMap(pair.value) && !replaceAt(childPath)) {
      overlayInto(existing.value, pair.value, childPath, replaceAt, from, into);
      continue;
    }
    const value = copyNode(pair.value, from, into);
    if (existing) {
      existing.value = value;
      if (isScalar(pair.key) && isScalar(existing.key) && pair.key.commentBefore) existing.key.commentBefore = pair.key.commentBefore;
    } else {
      const added = into.createPair(isScalar(pair.key) ? pair.key.value : key, null);
      added.value = value;
      if (isScalar(pair.key) && isScalar(added.key)) added.key.commentBefore = pair.key.commentBefore;
      target.items.push(added);
    }
  }
}

/**
 * The merged document: a copy of `shipped` (migrated) with `overlay` (migrated, parsed with `unset: "overlay"`; null
 * when there is none) laid over it, stamped with the code's `config_version`. Neither input is changed.
 */
export function toFull(name: ConfigName, shipped: Document, overlay: Document | null): Document {
  const out = shipped.clone();
  if (overlay && isMap(overlay.contents)) {
    if (isMap(out.contents)) overlayInto(out.contents, overlay.contents, [], replaceRule(name), overlay, out);
    else out.contents = copyNode(overlay.contents, overlay, out);
  }
  stampConfigVersion(out, currentConfigVersion(name));
  return out;
}

/** `toFull` as text, in the canonical form. */
export function toFullText(name: ConfigName, shipped: Document, overlay: Document | null): string {
  return stringifyConfigYaml(toFull(name, shipped, overlay));
}

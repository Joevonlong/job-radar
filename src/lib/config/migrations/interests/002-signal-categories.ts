/**
 * interests.yaml 1 -> 2: the fixed tiers become signal categories.
 *
 * - `signals.T1` -> an `amount` category `T1` (patterns, exclude; the amount settings under `amount:`), `T2`..`T4` ->
 *   `keyword` categories, `benefit_tags` + `benefit_patterns` -> the `tag` category `tag` (`tags`, `tag_patterns`).
 *   Names, icons, colours, `high_value` and the AI definitions are the ones the tiers always had
 *   (`DEFAULT_SIGNAL_CATEGORIES`); each weight comes from `weights.<id>`; T4 keeps its `ai_confirm_only` (v1 default on).
 * - `weights` is removed, `limits.per_tier_max` becomes `per_category_max`, `views[].filters.t12` becomes `high`,
 *   `signals.retired_categories: []` is added.
 * The existing nodes are moved, not rebuilt, so the comments written above a tier or a list stay with it. A document
 * that already has `signals.categories` is left alone (idempotent).
 */
import { isMap, isSeq, Pair, Scalar, YAMLMap, YAMLSeq, type Document } from "yaml";

import { defaultCategoryMeta, type DefaultCategoryMeta } from "@/lib/signals/defaults";

import type { ConfigMigration } from "../types";
import { keyComment, mapOf, pairOf, renameKey, takePair } from "../yaml-nodes";

/** Keys of the old T1 map that stay on the category; everything else known goes under `amount:`. */
const AMOUNT_SETTING_KEYS = ["min_annual_eur", "assume_currency", "bonus_requires_at_least", "rough_fx_to_eur", "other_region_weight"] as const;
const KEYWORD_TIERS = ["T2", "T3", "T4"] as const;

function scalarPair(doc: Document, key: string, value: unknown): Pair {
  return new Pair(doc.createNode(key), doc.createNode(value));
}

/** id, kind, label, icon, colour, weight, high_value: the head every migrated category starts with. */
function categoryHead(doc: Document, meta: DefaultCategoryMeta, weight: unknown): YAMLMap {
  const category = new YAMLMap();
  category.items.push(scalarPair(doc, "id", meta.id), scalarPair(doc, "kind", meta.kind));
  const label = doc.createNode({ zh: meta.label.zh, en: meta.label.en });
  if (isMap(label)) label.flow = true;
  category.items.push(new Pair(doc.createNode("label"), label));
  if (meta.icon !== undefined) category.items.push(scalarPair(doc, "icon", meta.icon));
  category.items.push(scalarPair(doc, "color", meta.color));
  category.items.push(new Pair(doc.createNode("weight"), weight ?? doc.createNode(0)));
  category.items.push(scalarPair(doc, "high_value", meta.high_value));
  return category;
}

/** The comment above the old key moves to the list entry. */
function carryComment(from: Pair | undefined, to: YAMLMap): void {
  if (!from) return;
  const { comment, space } = keyComment(from);
  if (comment) to.commentBefore = comment;
  if (space) to.spaceBefore = true;
}

function moveRest(from: YAMLMap, to: YAMLMap): void {
  for (const pair of from.items.splice(0)) to.items.push(pair);
}

function amountCategory(doc: Document, tierPair: Pair, weight: unknown, meta: DefaultCategoryMeta): YAMLMap {
  const category = categoryHead(doc, meta, weight);
  const old = isMap(tierPair.value) ? tierPair.value : new YAMLMap();
  const confirm = takePair(old, "ai_confirm_only");
  if (confirm) category.items.push(confirm);
  if (meta.ai_definition !== undefined) category.items.push(scalarPair(doc, "ai_definition", meta.ai_definition));
  const settings = new YAMLMap();
  for (const key of AMOUNT_SETTING_KEYS) {
    const pair = takePair(old, key);
    if (pair) settings.items.push(pair);
  }
  // patterns, exclude and anything unknown stay on the category (an unknown key is reported by the schema)
  moveRest(old, category);
  if (settings.items.length > 0) category.items.push(new Pair(doc.createNode("amount"), settings));
  carryComment(tierPair, category);
  return category;
}

function keywordCategory(doc: Document, tierPair: Pair, weight: unknown, meta: DefaultCategoryMeta): YAMLMap {
  const category = categoryHead(doc, meta, weight);
  const old = isMap(tierPair.value) ? tierPair.value : new YAMLMap();
  const confirm = takePair(old, "ai_confirm_only");
  // T4's broad words always waited for the AI unless the file said otherwise (v1 default)
  if (confirm) category.items.push(confirm);
  else if (meta.id === "T4") category.items.push(scalarPair(doc, "ai_confirm_only", true));
  if (meta.ai_definition !== undefined) category.items.push(scalarPair(doc, "ai_definition", meta.ai_definition));
  if (meta.default_kind !== undefined) category.items.push(scalarPair(doc, "default_kind", meta.default_kind));
  moveRest(old, category);
  carryComment(tierPair, category);
  return category;
}

function tagCategory(doc: Document, tagsPair: Pair | undefined, patternsPair: Pair | undefined, meta: DefaultCategoryMeta): YAMLMap {
  const category = categoryHead(doc, meta, null);
  if (meta.ai_definition !== undefined) category.items.push(scalarPair(doc, "ai_definition", meta.ai_definition));
  if (tagsPair) {
    renamePairKey(tagsPair, "tags");
    category.items.push(tagsPair);
  }
  if (patternsPair) {
    renamePairKey(patternsPair, "tag_patterns");
    category.items.push(patternsPair);
  }
  // the benefit tags' comment was written above `benefit_tags:`: it now describes the category
  const head = tagsPair ?? patternsPair;
  if (head) {
    const { comment, space } = keyComment(head);
    if (comment) {
      category.commentBefore = comment;
      if (head.key instanceof Scalar) head.key.commentBefore = undefined;
    }
    if (space) {
      category.spaceBefore = true;
      if (head.key instanceof Scalar) head.key.spaceBefore = false;
    }
  }
  return category;
}

function renamePairKey(pair: Pair, to: string): void {
  if (pair.key instanceof Scalar) pair.key.value = to;
  else pair.key = to;
}

function migrateSignals(doc: Document, root: YAMLMap): void {
  const signals = mapOf(root, "signals");
  if (!signals || pairOf(signals, "categories")) return;
  const weights = mapOf(root, "weights");
  const weightOf = (id: string): unknown => (weights ? (weights.get(id, true) ?? null) : null);

  // the comment above the first key of a map is the map's own comment: it belongs to that first tier
  const first = signals.items[0];
  if (first && signals.commentBefore && first.key instanceof Scalar && !first.key.commentBefore) {
    first.key.commentBefore = signals.commentBefore;
    signals.commentBefore = undefined;
  }

  const categories = new YAMLSeq();
  const t1 = takePair(signals, "T1");
  const t1Meta = defaultCategoryMeta("T1");
  if (t1 && t1Meta) categories.items.push(amountCategory(doc, t1, weightOf("T1"), t1Meta));
  for (const id of KEYWORD_TIERS) {
    const pair = takePair(signals, id);
    const meta = defaultCategoryMeta(id);
    if (pair && meta) categories.items.push(keywordCategory(doc, pair, weightOf(id), meta));
  }
  const tagsPair = takePair(signals, "benefit_tags");
  const patternsPair = takePair(signals, "benefit_patterns");
  const tagMeta = defaultCategoryMeta("tag");
  if (tagMeta && (tagsPair || patternsPair)) categories.items.push(tagCategory(doc, tagsPair, patternsPair, tagMeta));

  const retired = new YAMLSeq();
  retired.flow = true;
  signals.items.unshift(new Pair(doc.createNode("categories"), categories), new Pair(doc.createNode("retired_categories"), retired));
  if (weights) root.delete("weights");
}

function migrateViews(root: YAMLMap): void {
  const views: unknown = root.get("views", true);
  if (!isSeq(views)) return;
  for (const view of views.items) {
    if (!isMap(view)) continue;
    const filters = mapOf(view, "filters");
    if (filters) renameKey(filters, "t12", "high");
  }
}

export const interests002: ConfigMigration = {
  from: 1,
  to: 2,
  description: "signal tiers T1-T4 and benefit tags become signal categories; weights move onto them; per_tier_max -> per_category_max; view filter t12 -> high",
  migrate(doc: Document): void {
    const root = doc.contents;
    if (!isMap(root)) return;
    migrateSignals(doc, root);
    const limits = mapOf(root, "limits");
    if (limits) renameKey(limits, "per_tier_max", "per_category_max");
    migrateViews(root);
  },
};

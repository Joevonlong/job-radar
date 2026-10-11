import { configRegistry, type InterestsConfig } from "@/lib/config";
import type { JobListSignal } from "@/components/jobs/types";
import { buildCatalog, toCategoryViews, type CategoryView } from "@/lib/signals/catalog";
import { findCandidates, type RuleCandidate } from "@/lib/signals/rules";

import { shippedYaml } from "../config/helpers";
import { pipelineWith, shippedPipeline } from "../pipeline/helpers";

export function shippedInterests(edit: (raw: Record<string, unknown>) => void = () => {}): InterestsConfig {
  const raw = structuredClone(shippedYaml("interests.yaml"));
  edit(raw);
  return configRegistry.interests.schema.parse(raw);
}

export { pipelineWith, shippedPipeline };

/** Rule candidates of `text` with the shipped vocabulary (or an edited one). */
export function candidatesOf(text: string, interests: InterestsConfig = shippedInterests()): RuleCandidate[] {
  return findCandidates(text, interests, shippedPipeline());
}

export const tiersOf = (candidates: readonly RuleCandidate[]): string[] => candidates.map((c) => c.tier);

/** The raw category `id` of an interests.yaml v2 object, for `shippedInterests` edits. */
export function rawCategory(raw: Record<string, unknown>, id: string): Record<string, unknown> {
  const categories = (raw.signals as { categories: Array<Record<string, unknown>> }).categories;
  const found = categories.find((category) => category.id === id);
  if (!found) throw new Error(`no category ${id} in the fixture`);
  return found;
}

/** The raw category list of an interests.yaml v2 object. */
export function rawCategories(raw: Record<string, unknown>): Array<Record<string, unknown>> {
  return (raw.signals as { categories: Array<Record<string, unknown>> }).categories;
}

/** The raw `amount:` settings of the amount category `T1` (created when the fixture leaves them out). */
export function rawAmount(raw: Record<string, unknown>): Record<string, unknown> {
  const category = rawCategory(raw, "T1");
  category.amount ??= {};
  return category.amount as Record<string, unknown>;
}

/** The default categories as the client components get them. */
export function defaultCategoryViews(locale: "en" | "zh" = "en"): CategoryView[] {
  return toCategoryViews(buildCatalog(shippedInterests()), locale);
}

/** A row signal of the default categories, as `toListItems` makes it. */
export function listSignal(tier: string, kind: string, value: unknown, over: Record<string, unknown> = {}): JobListSignal {
  const view = defaultCategoryViews().find((c) => c.id === tier);
  if (!view) throw new Error(`no category ${tier}`);
  return { tier, kind, value, category: { kind: view.kind, label: view.label, icon: view.icon, color: view.color, code: view.code }, ...over };
}

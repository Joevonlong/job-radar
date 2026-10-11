import type { AiProviderIdChoice } from "@/lib/config/ai-options";
import { modelName, pickableModelViews, type CatalogModelView, type CatalogView } from "@/lib/settings/catalog-view";

import type { ModelChoice } from "./field-editors";

/** The two functions of next-intl a choice text needs, so the helpers stay plain functions. */
export interface ModelTextHelpers {
  /** `settings.controls.deprecatedOption` */
  deprecated: string;
  /** `settings.controls.notInCatalog` */
  notInCatalog: (model: string) => string;
  /** Number -> text with the locale's format. */
  number: (value: number) => string;
}

/** "Claude Haiku 4.5 · claude-haiku-4-5 · $1 / $5": display name, id, and for API models the price per 1M tokens. */
export function modelText(model: CatalogModelView, helpers: ModelTextHelpers): string {
  const parts = [model.label !== null ? `${modelName(model)} · ${model.id}` : model.id];
  if (model.price) parts.push(`$${helpers.number(model.price.input)} / $${helpers.number(model.price.output)}`);
  return parts.join(" · ") + (model.deprecated ? helpers.deprecated : "");
}

/**
 * What the dropdown of `provider` offers: the catalog's models that are not deprecated, plus the current value when it is
 * deprecated (flagged) or not in the catalog at all (flagged; saving it is refused). Without a catalog: only the current value.
 */
export function modelChoices(catalog: CatalogView | null | undefined, provider: AiProviderIdChoice, current: string, helpers: ModelTextHelpers): ModelChoice[] {
  if (!catalog) return current === "" ? [] : [{ value: current, text: current }];
  const entries = pickableModelViews(catalog, provider, current);
  const out = entries.map((m) => ({ value: m.id, text: modelText(m, helpers) }));
  if (current !== "" && !entries.some((m) => m.id === current)) out.push({ value: current, text: helpers.notInCatalog(current) });
  return out;
}

export type ModelStatus = "ok" | "deprecated" | "missing";

/** How the catalog sees the model currently selected for `provider` (an empty value is fine: "default"). */
export function modelStatus(catalog: CatalogView | null | undefined, provider: AiProviderIdChoice, current: string): ModelStatus {
  if (!catalog || current === "") return "ok";
  const found = catalog.providers[provider].models.find((m) => m.id === current);
  if (!found) return "missing";
  return found.deprecated ? "deprecated" : "ok";
}

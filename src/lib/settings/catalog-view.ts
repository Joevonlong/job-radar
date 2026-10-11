/**
 * The model catalog (models.yaml) as plain data for the browser: what the settings page needs to offer models
 * under their provider, mark deprecated ones and show the read-only catalog tables. Pure, no server-only imports.
 */
import { AI_PROVIDER_IDS, AI_PROVIDER_KIND, CODEX_REASONING_EFFORTS, type AiProviderIdChoice, type CodexReasoningEffort } from "../config/ai-options";
import type { ModelsConfig } from "../config/schemas/models";

export interface CatalogModelView {
  id: string;
  label: string | null;
  price: { input: number; output: number } | null;
  /** Subscription models only: the API list price of the same model, with where it came from. */
  equivalentPrice: { input: number; output: number; source: string } | null;
  /** codex-cli only: the efforts this model supports; null = all. */
  efforts: readonly CodexReasoningEffort[] | null;
  cliDefault: boolean;
  deprecated: boolean;
  notes: string | null;
  aliases: readonly string[];
}

export interface CatalogProviderView {
  id: AiProviderIdChoice;
  label: string;
  kind: "cli" | "api";
  docsUrl: string | null;
  notes: string | null;
  models: CatalogModelView[];
}

export interface CatalogView {
  providers: Record<AiProviderIdChoice, CatalogProviderView>;
}

export function toCatalogView(catalog: ModelsConfig): CatalogView {
  const providers = {} as Record<AiProviderIdChoice, CatalogProviderView>;
  for (const id of AI_PROVIDER_IDS) {
    const entry = catalog.providers[id];
    providers[id] = {
      id,
      label: entry.label,
      kind: AI_PROVIDER_KIND[id],
      docsUrl: entry.docs_url ?? null,
      notes: entry.notes ?? null,
      models: entry.models.map((m) => ({
        id: m.id,
        label: m.label ?? null,
        price: m.price ? { input: m.price.input_per_mtok, output: m.price.output_per_mtok } : null,
        equivalentPrice: m.equivalent_price ? { input: m.equivalent_price.input_per_mtok, output: m.equivalent_price.output_per_mtok, source: m.equivalent_price.source } : null,
        efforts: m.reasoning_efforts ?? null,
        cliDefault: m.cli_default === true,
        deprecated: m.deprecated === true,
        notes: m.notes ?? null,
        aliases: m.aliases ?? [],
      })),
    };
  }
  return { providers };
}

/** Display name of a model: its label, else its id. */
export const modelName = (model: CatalogModelView): string => model.label ?? model.id;

export function findModelView(catalog: CatalogView, provider: AiProviderIdChoice, id: string): CatalogModelView | null {
  return catalog.providers[provider].models.find((m) => m.id === id) ?? null;
}

/** Dropdown entries: the models that are not deprecated, plus the current value when it is. */
export function pickableModelViews(catalog: CatalogView, provider: AiProviderIdChoice, current?: string): CatalogModelView[] {
  return catalog.providers[provider].models.filter((m) => !m.deprecated || m.id === current);
}

export function cliDefaultView(catalog: CatalogView): CatalogModelView | null {
  return catalog.providers["codex-cli"].models.find((m) => m.cliDefault) ?? null;
}

/** codex: the efforts the model supports (`""` = the CLI default model); all of them when the catalog does not say. */
export function supportedEffortViews(catalog: CatalogView, model: string): readonly CodexReasoningEffort[] {
  const entry = model === "" ? cliDefaultView(catalog) : findModelView(catalog, "codex-cli", model);
  return entry?.efforts ?? CODEX_REASONING_EFFORTS;
}

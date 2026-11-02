/**
 * Refreshing the selectable models of a multi-model provider from the service itself. Shared by `pnpm models:sync` and the
 * `models_sync` control request (the "refresh models" button of /settings): both fetch the list, compare it with the
 * effective catalog and show the result; adding a model goes through `writeModelsOverlay` (the one writer of the user's
 * models.yaml). Nothing here writes a file.
 */
import { findCatalogModel, type CatalogModel, type ModelsConfig, type AiConfig } from "@/lib/config";

import { listOpenRouterModels } from "./openrouter";
import type { ListedModel, ModelSyncProvider, SyncPrice, SyncResult, SyncRow } from "./types";

export * from "./types";
export { listedFrom } from "./openrouter";

/** The most rows one result carries (a request's result lives in the database and is polled by the page). */
export const MAX_SYNC_ROWS = 300;

export interface ListDeps {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_LIST_TIMEOUT_MS = 30_000;

/** The service's model list, with the `base_url` and length-cap field taken from ai.yaml. */
export async function listProviderModels(provider: ModelSyncProvider, ai: Pick<AiConfig, "providers">, deps: ListDeps = {}): Promise<ListedModel[]> {
  switch (provider) {
    case "openrouter": {
      const config = ai.providers.openrouter;
      return listOpenRouterModels({
        baseUrl: config.base_url,
        maxTokensField: config.max_tokens_field,
        timeoutMs: deps.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS,
        ...(deps.signal ? { signal: deps.signal } : {}),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.env ? { env: deps.env } : {}),
      });
    }
  }
}

const same = (a: number | undefined, b: number | undefined): boolean => a !== undefined && b !== undefined && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** The catalog's price when it differs from the listed one: input and output always, the cache prices when both sides have them. */
function changedPrice(catalogPrice: SyncPrice | undefined, listed: SyncPrice | null): SyncPrice | null {
  if (!catalogPrice || !listed) return null;
  const differs =
    !same(catalogPrice.input_per_mtok, listed.input_per_mtok) ||
    !same(catalogPrice.output_per_mtok, listed.output_per_mtok) ||
    (catalogPrice.cached_input_per_mtok !== undefined && listed.cached_input_per_mtok !== undefined && !same(catalogPrice.cached_input_per_mtok, listed.cached_input_per_mtok)) ||
    (catalogPrice.cache_write_per_mtok !== undefined && listed.cache_write_per_mtok !== undefined && !same(catalogPrice.cache_write_per_mtok, listed.cache_write_per_mtok));
  return differs ? { ...catalogPrice } : null;
}

/** A model that has not expired yet (`today` as YYYY-MM-DD; a model that expires today is gone). */
const current = (model: ListedModel, today: string): boolean => model.expiresOn === null || model.expiresOn > today;

export function compareWithCatalog(model: ListedModel, catalog: ModelsConfig, provider: ModelSyncProvider, today: string): SyncRow {
  const found = findCatalogModel(catalog, provider, model.id);
  const usable = model.textChat && model.price !== null && current(model, today);
  return {
    ...model,
    inCatalog: found !== null,
    priceWas: found ? changedPrice(found.model.price, model.price) : null,
    addable: usable && model.json === "yes",
    addableUnverified: usable && model.json === "unverified",
  };
}

export interface BuildOptions {
  /** Case-insensitive; matches the id or the name. */
  filter?: string | undefined;
  now?: Date;
  /** Rows kept (default `MAX_SYNC_ROWS`). */
  maxRows?: number;
}

/**
 * The rows for the listed models next to the catalog: chat models first when they can be added, then the others, each by id;
 * `gone` = the catalog's models (not deprecated) the service no longer lists, whatever the filter.
 */
export function buildSyncResult(provider: ModelSyncProvider, listed: readonly ListedModel[], catalog: ModelsConfig, options: BuildOptions = {}): SyncResult {
  const now = options.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const needle = options.filter?.trim().toLowerCase() ?? "";
  const rows = listed
    .filter((model) => needle === "" || model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle))
    .map((model) => compareWithCatalog(model, catalog, provider, today));
  const rank = (row: SyncRow): number => (row.addable ? 0 : row.addableUnverified ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  const maxRows = options.maxRows ?? MAX_SYNC_ROWS;
  const listedIds = new Set(listed.map((model) => model.id));
  const gone = catalog.providers[provider].models
    .filter((model) => !model.deprecated && !listedIds.has(model.id) && !(model.aliases ?? []).some((alias) => listedIds.has(alias)))
    .map((model) => model.id);
  return { provider, fetchedAt: now.toISOString(), listed: listed.length, matched: rows.length, truncated: rows.length > maxRows, rows: rows.slice(0, maxRows), gone };
}

/** `Anthropic: Claude Haiku 5.5` -> `Claude Haiku 5.5` (the vendor already is the id's prefix). */
export function displayLabel(name: string): string {
  const at = name.indexOf(": ");
  return (at > 0 ? name.slice(at + 2) : name).trim();
}

/** The catalog entry for a listed model: a new one (`label`, `price`, the sync date in `notes`) or the effective one with its price updated. */
export function catalogEntryFor(row: SyncRow, existing: CatalogModel | null, date: string, unverified = false): CatalogModel {
  if (row.price === null) throw new Error(`model "${row.id}" has no usable price`);
  const note = `synced ${date}${unverified ? "; JSON mode unverified" : ""}`;
  if (existing) {
    // keep what the catalog already says about the model; only the sync stamp is replaced
    const earlier = existing.notes?.replace(/;?\s*synced \d{4}-\d{2}-\d{2}[^;]*$/, "").trim();
    return { ...existing, price: row.price, notes: earlier ? `${earlier}; ${note}` : note };
  }
  return { id: row.id, label: displayLabel(row.name), price: row.price, notes: note };
}

import { z } from "zod";

import type { AiProviderIdChoice } from "@/lib/config/ai-options";

/** The providers whose models can be listed from the service (`providers/<id>/models` of the sync adapters). */
export const MODEL_SYNC_PROVIDERS = ["openrouter"] as const satisfies readonly AiProviderIdChoice[];
export type ModelSyncProvider = (typeof MODEL_SYNC_PROVIDERS)[number];

export function isModelSyncProvider(value: string): value is ModelSyncProvider {
  return (MODEL_SYNC_PROVIDERS as readonly string[]).includes(value);
}

/** USD per 1M tokens, as the catalog keeps it. */
export const syncPriceSchema = z.strictObject({
  input_per_mtok: z.number().nonnegative(),
  output_per_mtok: z.number().nonnegative(),
  cached_input_per_mtok: z.number().nonnegative().optional(),
  cache_write_per_mtok: z.number().nonnegative().optional(),
});
export type SyncPrice = z.infer<typeof syncPriceSchema>;

/**
 * Whether the service says the model can answer in JSON mode (`response_format`): `yes`, `no` (it lists its parameters and
 * `response_format` is not among them), `unverified` (the metadata does not say; listed, never added without asking).
 */
export const JSON_SUPPORT = ["yes", "no", "unverified"] as const;

/** One model the service lists, reduced to what the catalog needs. */
export const listedModelSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  /** A text-in, text-out chat model (not an image, audio or embedding model). */
  textChat: z.boolean(),
  /** null: no usable price (missing, negative, not a number). */
  price: syncPriceSchema.nullable(),
  contextLength: z.number().int().nonnegative().nullable(),
  json: z.enum(JSON_SUPPORT),
  /** The service stops offering it on this date (YYYY-MM-DD); in the past = already gone. */
  expiresOn: z.string().nullable(),
});
export type ListedModel = z.infer<typeof listedModelSchema>;

/** A listed model next to the effective catalog. */
export const syncRowSchema = listedModelSchema.extend({
  inCatalog: z.boolean(),
  /** The catalog has a price for it and it differs from the listed one: what the catalog has. */
  priceWas: syncPriceSchema.nullable(),
  /** Can be added (or its price updated) without `--allow-unverified`: a priced, current, text chat model with JSON mode. */
  addable: z.boolean(),
  /** Can be added only by asking for it (JSON support unverified). */
  addableUnverified: z.boolean(),
});
export type SyncRow = z.infer<typeof syncRowSchema>;

/** What a `models_sync` request returns, and what `pnpm models:sync` prints. */
export const syncResultSchema = z.strictObject({
  provider: z.enum(MODEL_SYNC_PROVIDERS),
  /** ISO time of the fetch. */
  fetchedAt: z.iso.datetime(),
  /** Models the service lists / of them the rows that match the filter. */
  listed: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  /** More rows matched than are returned. */
  truncated: z.boolean(),
  rows: z.array(syncRowSchema),
  /** Catalog models (not deprecated) the service no longer lists: only flagged, never removed. */
  gone: z.array(z.string()),
});
export type SyncResult = z.infer<typeof syncResultSchema>;

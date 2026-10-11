/**
 * Before market packs Job Radar only supported Germany, so every file older than the packs migrates to the
 * German market. The values here are what that meant; they belong to the migrations only (C8 allow-list).
 */
import type { Document } from "yaml";

import { migrateRemoteScope } from "@/lib/market/remote-scope";

import { setValue, valueAt } from "./edit";

/** preferences.yaml `market` written by the migration. */
export const LEGACY_MARKET = { pack: "de", country: "DE", currency: "EUR", home_language: "de" } as const;

/** `remote_scope: eu_hire_in_de | eu_any` -> `home_country | { region: [eu] }` (other values unchanged). */
export function migrateRemoteScopeAt(doc: Document, path: readonly string[]): void {
  const current = valueAt(doc, path);
  const next = migrateRemoteScope(current);
  if (next !== current) setValue(doc, path, next);
}

/** Keys of a channel's `remote_locations` block before / after the market packs. */
export const REMOTE_LOCATION_RENAMES = [
  ["eu_hire_in_de", "home_country"],
  ["eu_any", "region"],
] as const;

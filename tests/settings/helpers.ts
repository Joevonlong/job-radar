import fs from "node:fs";
import path from "node:path";

import { parse } from "yaml";

import { parseConfigText } from "@/lib/config";
import { configRegistry } from "@/lib/config/registry";
import { toCatalogView, type CatalogView } from "@/lib/settings/catalog-view";
import type { SettingsForm } from "@/lib/settings/tabs";

const SHIPPED_CONFIG_DIR = path.resolve(import.meta.dirname, "../fixtures/config/defaults");

/** The shipped config file `tab`, parsed and validated (the same value the settings page loads). */
export function shippedConfig(tab: SettingsForm): unknown {
  const file = path.join(SHIPPED_CONFIG_DIR, tab === "channels" ? "sources.yaml" : `${tab}.yaml`);
  return parseConfigText(tab, fs.readFileSync(file, "utf8"), file);
}

/** The shipped models.yaml as plain data. */
export function shippedCatalogRaw(): unknown {
  return parse(fs.readFileSync(path.join(SHIPPED_CONFIG_DIR, "models.yaml"), "utf8"));
}

/** The shipped catalog as the browser gets it, optionally edited first (`raw.providers[<id>].models`). */
export function shippedCatalogView(edit: (raw: { providers: Record<string, { models: Record<string, unknown>[] }> }) => void = () => {}): CatalogView {
  const raw = structuredClone(shippedCatalogRaw()) as { providers: Record<string, { models: Record<string, unknown>[] }> };
  edit(raw);
  return toCatalogView(configRegistry.models.schema.parse(raw));
}

/** `shippedCatalogView` without any optional `equivalent_price`; `edit` sets exactly the ones a test needs. */
export function bareCatalogView(edit: (raw: { providers: Record<string, { models: Record<string, unknown>[] }> }) => void = () => {}): CatalogView {
  return shippedCatalogView((raw) => {
    for (const provider of Object.values(raw.providers)) for (const model of provider.models) delete model.equivalent_price;
    edit(raw);
  });
}

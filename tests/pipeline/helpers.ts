import path from "node:path";

import { configRegistry, parseConfigText, type PipelineConfig, type PipelineFileConfig } from "@/lib/config";
import type { NormalizedPostingDraft } from "@/lib/channels/types";
import { buildEffectivePipeline, buildMarket, readPackDir, type Market, type MarketSettings, type Pack } from "@/lib/market";

import { FIXTURE_DEFAULTS_DIR, shippedYaml } from "../config/helpers";

const packCache = new Map<string, Pack>();

/** The fixture's packs (`tests/fixtures/config/defaults/packs`), never the repository's. */
export function fixturePack(id: string): Pack {
  let pack = packCache.get(id);
  if (!pack) {
    pack = readPackDir(id, path.join(FIXTURE_DEFAULTS_DIR, "packs", id), "shipped");
    packCache.set(id, pack);
  }
  return pack;
}

/** A market built from the fixture packs (default: the German market of the fixture preferences). */
export function fixtureMarket(settings: MarketSettings = { pack: "de" }): Market {
  return buildMarket(settings, fixturePack("generic"), settings.pack === "generic" ? fixturePack("generic") : fixturePack(settings.pack));
}

/** The fixture's pipeline.yaml as a file (migrated in memory when older). */
export function shippedPipelineFile(edit: (raw: Record<string, unknown>) => void = () => {}): PipelineFileConfig {
  const raw = structuredClone(shippedYaml("pipeline.yaml"));
  edit(raw);
  return configRegistry.pipeline.schema.parse(Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "config_version")));
}

/** The effective pipeline config of the fixture under a market (default: DE): pipeline.yaml + generic + market pack. */
export function shippedPipeline(market: Market = fixtureMarket()): PipelineConfig {
  return buildEffectivePipeline(shippedPipelineFile(), market, fixturePack);
}

/** The effective config with a deep edit of pipeline.yaml applied (the file is re-validated; lists add to the packs'). */
export function pipelineWith(edit: (raw: Record<string, unknown>) => void, market: Market = fixtureMarket()): PipelineConfig {
  return buildEffectivePipeline(shippedPipelineFile(edit), market, fixturePack);
}

/** A market whose pack `id` is changed by `edit` (a copy; the fixture stays), and the loader that serves it. */
export function editedPack(id: string, edit: (pack: Pack) => void, settings: MarketSettings = { pack: "de" }): { market: Market; loader: (packId: string) => Pack } {
  const changed = structuredClone(fixturePack(id));
  edit(changed);
  const loader = (packId: string): Pack => (packId === id ? changed : fixturePack(packId));
  return { market: buildMarket(settings, loader("generic"), settings.pack === "generic" ? loader("generic") : loader(settings.pack)), loader };
}

/** The effective config with a market pack edited (rules that come from the pack can only be removed there). */
export function pipelineWithPack(id: string, edit: (pack: Pack) => void, settings: MarketSettings = { pack: "de" }): PipelineConfig {
  const { market, loader } = editedPack(id, edit, settings);
  return buildEffectivePipeline(shippedPipelineFile(), market, loader);
}

/** Parse pipeline.yaml text (with in-memory migration) — for tests that start from YAML text. */
export function pipelineFromText(text: string, market: Market = fixtureMarket()): PipelineConfig {
  return buildEffectivePipeline(parseConfigText("pipeline", text, "pipeline.yaml"), market, fixturePack);
}

export function draft(overrides: Partial<NormalizedPostingDraft> = {}): NormalizedPostingDraft {
  return {
    title: "Applied AI Engineer (m/w/d)",
    companyName: "Northwind Labs GmbH",
    locations: [{ label: "Berlin", city: "Berlin", countryCode: "DE" }],
    workplace: "hybrid",
    description: "Build LLM-powered features for our logistics platform.",
    applyUrl: "https://jobs.example.test/northwind/1001",
    sourceUrl: "https://jobs.example.test/northwind/1001",
    ...overrides,
  };
}

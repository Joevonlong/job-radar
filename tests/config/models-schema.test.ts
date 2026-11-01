// @vitest-environment node
import { describe, expect, it } from "vitest";

import { configRegistry } from "@/lib/config";

import { shippedYaml } from "./helpers";

type Providers = Record<string, { models: Record<string, unknown>[]; [k: string]: unknown }>;

const parse = (edit: (providers: Providers, raw: Record<string, unknown>) => void) => {
  const raw = structuredClone(shippedYaml("models.yaml"));
  edit(raw.providers as Providers, raw);
  return configRegistry.models.schema.safeParse(raw);
};
const paths = (edit: (providers: Providers, raw: Record<string, unknown>) => void): string[] => {
  const result = parse(edit);
  return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
};

describe("models.yaml schema", () => {
  it("accepts the shipped catalog", () => {
    expect(parse(() => {}).success).toBe(true);
  });

  it("requires a price for API models and forbids one for subscription CLIs", () => {
    expect(paths((p) => { delete p.anthropic!.models[0]!.price; })).toEqual(["providers.anthropic.models.0.price"]);
    expect(paths((p) => { p["claude-cli"]!.models[0]!.price = { input_per_mtok: 1, output_per_mtok: 2 }; })).toEqual(["providers.claude-cli.models.0.price"]);
    expect(paths((p) => { p.mimo!.models[0]!.price = { input_per_mtok: -1, output_per_mtok: 2 }; })).toEqual(["providers.mimo.models.0.price.input_per_mtok"]);
  });

  it("rejects duplicate ids and clashing aliases within a provider (the same id in two providers is fine)", () => {
    expect(paths((p) => { p.deepseek!.models.push({ id: "deepseek-v4-flash", price: { input_per_mtok: 1, output_per_mtok: 1 } }); })).toEqual(["providers.deepseek.models.2.id"]);
    expect(paths((p) => { p.deepseek!.models[0]!.aliases = ["deepseek-v4-pro"]; })).toEqual(["providers.deepseek.models.0.aliases.0"]);
    expect(paths((p) => { p.deepseek!.models[0]!.aliases = ["x"]; p.deepseek!.models[1]!.aliases = ["x"]; })).toEqual(["providers.deepseek.models.1.aliases.0"]);
    expect(paths((p) => { p.deepseek!.models[0]!.aliases = ["deepseek-v4-flash"]; })).toEqual(["providers.deepseek.models.0.aliases.0"]);
  });

  it("allows reasoning_efforts and cli_default only under codex-cli, and one cli_default at most", () => {
    expect(paths((p) => { p["claude-cli"]!.models[0]!.reasoning_efforts = ["low"]; })).toEqual(["providers.claude-cli.models.0.reasoning_efforts"]);
    expect(paths((p) => { p.anthropic!.models[0]!.cli_default = true; })).toEqual(["providers.anthropic.models.0.cli_default"]);
    expect(paths((p) => { p["codex-cli"]!.models[0]!.reasoning_efforts = ["low", "high"]; })).toEqual([]);
    expect(paths((p) => { p["codex-cli"]!.models[0]!.reasoning_efforts = ["low", "low"]; })).toEqual(["providers.codex-cli.models.0.reasoning_efforts"]);
    expect(paths((p) => { p["codex-cli"]!.models.push({ id: "gpt-x", cli_default: true }); })).toEqual(["providers.codex-cli.models.1.cli_default"]);
  });

  it("rejects an unknown or missing provider, an empty list, a bad id and an unknown key", () => {
    expect(paths((p) => { p.acme = structuredClone(p.mimo!); })).toContain("providers");
    expect(paths((p) => { delete p.mimo; })).toEqual(["providers.mimo"]);
    expect(paths((p) => { p.mimo!.models = []; })).toEqual(["providers.mimo.models"]);
    expect(paths((p) => { p.mimo!.models[0]!.id = "has space"; })).toEqual(["providers.mimo.models.0.id"]);
    expect(paths((p) => { p.mimo!.models[0]!.typo = 1; })).toEqual(["providers.mimo.models.0"]);
    expect(paths((p) => { p.mimo!.docs_url = "not a url"; })).toEqual(["providers.mimo.docs_url"]);
  });

  it("accepts equivalent_price and cache prices on subscription CLIs / API models", () => {
    expect(paths((p) => { p["claude-cli"]!.models[0]!.equivalent_price = { input_per_mtok: 1, output_per_mtok: 5, cached_input_per_mtok: 0.1, cache_write_per_mtok: 1.25, source: "Anthropic API price list, 2026-10" }; })).toEqual([]);
    expect(paths((p) => { Object.assign(p.anthropic!.models[0]!.price as object, { cached_input_per_mtok: 0.1, cache_write_per_mtok: 1.25 }); })).toEqual([]);
  });

  it("rejects equivalent_price on an API model, without source, or with a negative price", () => {
    expect(paths((p) => { p.anthropic!.models[0]!.equivalent_price = { input_per_mtok: 1, output_per_mtok: 5, source: "x" }; })).toEqual(["providers.anthropic.models.0.equivalent_price"]);
    expect(paths((p) => { p["claude-cli"]!.models[0]!.equivalent_price = { input_per_mtok: 1, output_per_mtok: 5 }; })).toEqual(["providers.claude-cli.models.0.equivalent_price.source"]);
    expect(paths((p) => { p["claude-cli"]!.models[0]!.equivalent_price = { input_per_mtok: 1, output_per_mtok: 5, cached_input_per_mtok: -1, source: "x" }; })).toEqual(["providers.claude-cli.models.0.equivalent_price.cached_input_per_mtok"]);
  });

  it("the phase-2 models.yaml blocks of docs/ai-usage.md are valid", () => {
    const source = "Official API price list, checked 2026-10-08";
    expect(paths((p) => {
      p["claude-cli"]!.models[0]!.equivalent_price = { input_per_mtok: 1, output_per_mtok: 5, cached_input_per_mtok: 0.1, cache_write_per_mtok: 1.25, source };
      p["claude-cli"]!.models[1]!.equivalent_price = { input_per_mtok: 2, output_per_mtok: 10, cached_input_per_mtok: 0.1, cache_write_per_mtok: 2.5, source };
      p["claude-cli"]!.models[2]!.equivalent_price = { input_per_mtok: 4, output_per_mtok: 20, cached_input_per_mtok: 0.2, cache_write_per_mtok: 5, source };
      p["codex-cli"]!.models[0]!.equivalent_price = { input_per_mtok: 2, output_per_mtok: 10, cached_input_per_mtok: 0.1, cache_write_per_mtok: 2.5, source };
    })).toEqual([]);
  });
});

describe("models.yaml schema, the new catalog shape", () => {
  it("accepts a deprecated model with notes and cache prices, and a codex model with ultra", () => {
    expect(paths((p) => {
      p.mimo!.models.push({ id: "mimo-old", deprecated: true, notes: "gone 2026-10-21", price: { input_per_mtok: 0.4, output_per_mtok: 0.8, cached_input_per_mtok: 0.003 } });
      p["codex-cli"]!.models[0]!.reasoning_efforts = ["high", "ultra"];
    })).toEqual([]);
  });
});

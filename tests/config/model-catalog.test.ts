// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  checkAiAgainstCatalog,
  cliDefaultModel,
  equivalentModelPrice,
  findCatalogModel,
  modelPrice,
  pickableModels,
  supportedEfforts,
  type AiConfig,
  type ModelsConfig,
} from "@/lib/config";

import { CODEX_REASONING_EFFORTS } from "@/lib/config/ai-options";

import { bareCatalog, shippedAi, shippedCatalog } from "../ai/helpers";

type Providers = Record<string, { models: Record<string, unknown>[] }>;
const catalogWith = (edit: (p: Providers) => void): ModelsConfig => shippedCatalog((raw) => edit(raw.providers as Providers));
const aiWith = (edit: (raw: Record<string, unknown>) => void): AiConfig => shippedAi(edit);
type AiProviders = Record<string, Record<string, unknown>>;

describe("catalog lookups", () => {
  const catalog = catalogWith((p) => {
    p.anthropic!.models[0]!.aliases = ["claude-haiku-4-5-20251001"];
    p.deepseek!.models[1]!.deprecated = true;
  });

  it("finds a model by id, then by alias, case-sensitively", () => {
    expect(findCatalogModel(catalog, "anthropic", "claude-haiku-4-5")).toMatchObject({ by: "id" });
    expect(findCatalogModel(catalog, "anthropic", "claude-haiku-4-5-20251001")).toMatchObject({ by: "alias", model: { id: "claude-haiku-4-5" } });
    expect(findCatalogModel(catalog, "anthropic", "Claude-Haiku-4-5")).toBeNull();
    // the same id under another provider is another entry
    expect(findCatalogModel(catalog, "claude-cli", "claude-sonnet-5-5")?.model.price).toBeUndefined();
    expect(findCatalogModel(catalog, "deepseek", "claude-haiku-4-5")).toBeNull();
  });

  it("offers only models that are not deprecated, plus the current value", () => {
    expect(pickableModels(catalog, "deepseek").map((m) => m.id)).toEqual(["deepseek-v4-flash"]);
    expect(pickableModels(catalog, "deepseek", "deepseek-v4-pro").map((m) => m.id)).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
  });

  it("prices exact, by alias, and at the provider's highest price when the name is unknown", () => {
    expect(modelPrice(catalog, "deepseek", "deepseek-v4-pro")).toEqual({ price: { input_per_mtok: 1.32, output_per_mtok: 3.96 }, priced: "exact" });
    expect(modelPrice(catalog, "anthropic", "claude-haiku-4-5-20251001")?.priced).toBe("exact");
    expect(modelPrice(catalog, "deepseek", "x")).toEqual({ price: { input_per_mtok: 1.32, output_per_mtok: 3.96 }, priced: "fallback" });
    expect(modelPrice(catalog, "claude-cli", "claude-haiku-4-5")).toBeNull();
  });

  it("supportedEfforts: all when unlisted, the CLI default model when none is named", () => {
    expect(supportedEfforts(catalog, "gpt-6.1-sol")).toHaveLength(CODEX_REASONING_EFFORTS.length);
    const narrowed = catalogWith((p) => { p["codex-cli"]!.models[0]!.reasoning_efforts = ["low", "medium"]; });
    expect(supportedEfforts(narrowed, undefined)).toEqual(["low", "medium"]);
    expect(supportedEfforts(narrowed, "gpt-6.1-sol")).toEqual(["low", "medium"]);
    expect(supportedEfforts(narrowed, "unknown-model")).toHaveLength(CODEX_REASONING_EFFORTS.length);
    expect(cliDefaultModel(narrowed)?.id).toBe("gpt-6.1-sol");
    const noDefault = catalogWith((p) => { delete p["codex-cli"]!.models[0]!.cli_default; p["codex-cli"]!.models[0]!.reasoning_efforts = ["low"]; });
    expect(supportedEfforts(noDefault, undefined)).toHaveLength(CODEX_REASONING_EFFORTS.length);
  });
});

describe("ultra reasoning effort", () => {
  it("is a valid effort in the AI config and in a model's reasoning_efforts", () => {
    expect(CODEX_REASONING_EFFORTS).toContain("ultra");
    expect(() => aiWith((raw) => { ((raw.providers as AiProviders).codex_cli as Record<string, unknown>).reasoning_effort = "ultra"; })).not.toThrow();
    const catalog = catalogWith((p) => { p["codex-cli"]!.models[0]!.reasoning_efforts = ["high", "ultra"]; });
    expect(supportedEfforts(catalog, "gpt-6.1-sol")).toEqual(["high", "ultra"]);
  });
});

describe("checkAiAgainstCatalog", () => {
  it("passes for the shipped files", () => {
    expect(checkAiAgainstCatalog(shippedAi(), shippedCatalog()).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("flags a selected model that is not in the provider's catalog, and does not take an alias for a selection", () => {
    const catalog = catalogWith((p) => { p.anthropic!.models[0]!.aliases = ["haiku-snapshot"]; });
    const issues = checkAiAgainstCatalog(aiWith((raw) => {
      const p = raw.providers as AiProviders;
      p.claude_cli!.model = "nope";
      p.anthropic!.strong_model = "haiku-snapshot";
      p.codex_cli!.model = "gpt-5";
      p.deepseek!.model = "claude-haiku-4-5"; // a model of another provider
    }), catalog);
    expect(issues.map((i) => i.path.join("."))).toEqual([
      "providers.claude_cli.model",
      "providers.anthropic.strong_model",
      "providers.deepseek.model",
      "providers.codex_cli.model",
    ]);
    expect(issues.every((i) => i.code === "not_in_catalog" && i.severity === "error")).toBe(true);
  });

  it("flags a task model that is not in the catalog", () => {
    const issues = checkAiAgainstCatalog(aiWith((raw) => {
      (raw.tasks as Record<string, unknown>).translate = { order: ["codex-cli", "claude-cli"], models: { "claude-cli": "claude-nope" } };
    }), shippedCatalog());
    expect(issues).toEqual([expect.objectContaining({ path: ["tasks", "translate", "models", "claude-cli"], code: "not_in_catalog" })]);
  });

  it("warns about a deprecated selection without failing", () => {
    const catalog = catalogWith((p) => { p["claude-cli"]!.models[0]!.deprecated = true; });
    const issues = checkAiAgainstCatalog(shippedAi(), catalog);
    expect(issues).toEqual([expect.objectContaining({ path: ["providers", "claude_cli", "model"], code: "deprecated", severity: "warning" })]);
  });

  it("checks the codex reasoning effort against the model used: global, per task, and the task's own model", () => {
    const narrowed = catalogWith((p) => {
      p["codex-cli"]!.models[0]!.reasoning_efforts = ["low"];
      p["codex-cli"]!.models.push({ id: "gpt-mini", reasoning_efforts: ["minimal"] });
    });
    const codexAi = (edit: (codex: Record<string, unknown>, raw: Record<string, unknown>) => void) =>
      aiWith((raw) => {
        const codex = (raw.providers as AiProviders).codex_cli!;
        delete codex.model;
        codex.reasoning_effort = "low";
        codex.reasoning_effort_by_task = {};
        edit(codex, raw);
      });
    expect(checkAiAgainstCatalog(codexAi(() => {}), narrowed)).toEqual([]);
    // global effort not supported by the CLI default model
    expect(checkAiAgainstCatalog(codexAi((c) => { c.reasoning_effort = "high"; }), narrowed).map((i) => i.path.join("."))).toEqual(["providers.codex_cli.reasoning_effort"]);
    // per-task effort
    expect(checkAiAgainstCatalog(codexAi((c) => { c.reasoning_effort_by_task = { translate: "max" }; }), narrowed).map((i) => i.path.join("."))).toEqual([
      "providers.codex_cli.reasoning_effort_by_task.translate",
    ]);
    // a task that overrides the codex model: the global effort is checked against that model
    const taskModel = codexAi((_c, raw) => { (raw.tasks as Record<string, unknown>).translate = { order: ["codex-cli"], models: { "codex-cli": "gpt-mini" } }; });
    expect(checkAiAgainstCatalog(taskModel, narrowed).map((i) => i.path.join("."))).toEqual(["tasks.translate.models.codex-cli"]);
  });
});

describe("equivalentModelPrice", () => {
  const catalog = bareCatalog((raw) => {
    const p = raw.providers as Providers;
    p["claude-cli"]!.models[0]!.aliases = ["claude-haiku-4-5-20251001"];
    p["claude-cli"]!.models[0]!.equivalent_price = { input_per_mtok: 1, output_per_mtok: 5, source: "test" };
  });
  it("finds a subscription model's price by id and by alias", () => {
    expect(equivalentModelPrice(catalog, "claude-cli", "claude-haiku-4-5")).toMatchObject({ by: "id", price: { input_per_mtok: 1 } });
    expect(equivalentModelPrice(catalog, "claude-cli", "claude-haiku-4-5-20251001")).toMatchObject({ by: "alias" });
  });
  it("is null for an unknown model, a model without one, and API providers (no fallback to a highest price)", () => {
    expect(equivalentModelPrice(catalog, "claude-cli", "mystery")).toBeNull();
    expect(equivalentModelPrice(catalog, "claude-cli", "claude-sonnet-5-5")).toBeNull();
    expect(equivalentModelPrice(catalog, "anthropic", "claude-haiku-4-5")).toBeNull();
  });
});

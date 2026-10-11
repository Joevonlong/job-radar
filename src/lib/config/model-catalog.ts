/**
 * Pure helpers over the model catalog (`config/models.yaml`) and the cross-file check against the choices in
 * `ai.yaml`. Nothing here reads a file: callers load both configs.
 */
import { AI_PROVIDER_KIND, AI_TASK_NAMES, CODEX_REASONING_EFFORTS, type AiProviderIdChoice, type CodexReasoningEffort } from "./ai-options";
import type { AiConfig } from "./schemas/ai";
import type { CatalogModel, ModelsConfig } from "./schemas/models";

export interface ModelPrice {
  input_per_mtok: number;
  output_per_mtok: number;
  /** Absent = priced like normal input. */
  cached_input_per_mtok?: number | undefined;
  cache_write_per_mtok?: number | undefined;
}

export type CatalogMatch = { model: CatalogModel; by: "id" | "alias" };

export function catalogModels(catalog: ModelsConfig, provider: AiProviderIdChoice): readonly CatalogModel[] {
  return catalog.providers[provider].models;
}

/** By id first, then by `aliases`; case-sensitive. */
export function findCatalogModel(catalog: ModelsConfig, provider: AiProviderIdChoice, name: string): CatalogMatch | null {
  const models = catalogModels(catalog, provider);
  const byId = models.find((m) => m.id === name);
  if (byId) return { model: byId, by: "id" };
  const byAlias = models.find((m) => m.aliases?.includes(name));
  return byAlias ? { model: byAlias, by: "alias" } : null;
}

/** What a dropdown offers: the models not deprecated, plus the current value when it is deprecated. */
export function pickableModels(catalog: ModelsConfig, provider: AiProviderIdChoice, current?: string): readonly CatalogModel[] {
  return catalogModels(catalog, provider).filter((m) => !m.deprecated || m.id === current);
}

/**
 * Price of the model name a reply reported: found by id / alias = exact; otherwise the highest input and the highest
 * output price of the provider's catalog (better to over-count than to let the budget leak) = fallback;
 * null when the provider has no priced model.
 */
export function modelPrice(catalog: ModelsConfig, provider: AiProviderIdChoice, reported: string): { price: ModelPrice; priced: "exact" | "fallback" } | null {
  const match = findCatalogModel(catalog, provider, reported);
  if (match?.model.price) return { price: match.model.price, priced: "exact" };
  const priced = catalogModels(catalog, provider).flatMap((m) => (m.price ? [m.price] : []));
  if (priced.length === 0) return null;
  return {
    price: {
      input_per_mtok: Math.max(...priced.map((p) => p.input_per_mtok)),
      output_per_mtok: Math.max(...priced.map((p) => p.output_per_mtok)),
    },
    priced: "fallback",
  };
}

/**
 * The API list price of a subscription CLI model (`equivalent_price`), by id then alias. null when the provider is
 * an API provider, the model is unknown or has no equivalent price: an equivalent cost is better unknown than invented
 * (unlike `modelPrice`, there is no fallback).
 */
export function equivalentModelPrice(catalog: ModelsConfig, provider: AiProviderIdChoice, reported: string): { price: ModelPrice; by: "id" | "alias" } | null {
  if (AI_PROVIDER_KIND[provider] !== "cli") return null;
  const match = findCatalogModel(catalog, provider, reported);
  const price = match?.model.equivalent_price;
  return match && price ? { price, by: match.by } : null;
}

export function cliDefaultModel(catalog: ModelsConfig): CatalogModel | null {
  return catalogModels(catalog, "codex-cli").find((m) => m.cli_default) ?? null;
}

/**
 * The model name to show for a stored `model` of `provider`: codex's "codex-default" placeholder (older rows keep it) is the catalog's `cli_default` model, as `ai_usage` records it. `byCliDefault` marks that case.
 */
export function resolveShownModel(catalog: ModelsConfig | null, provider: string | null, model: string | null): { model: string | null; byCliDefault: boolean } {
  if (provider === "codex-cli" && model === "codex-default") {
    const fallback = catalog ? cliDefaultModel(catalog) : null;
    if (fallback) return { model: fallback.id, byCliDefault: true };
  }
  return { model, byCliDefault: false };
}

/**
 * codex: the efforts this model supports. `model` undefined = the CLI default one. No entry or no
 * `reasoning_efforts` = all of them.
 */
export function supportedEfforts(catalog: ModelsConfig, model: string | undefined): readonly CodexReasoningEffort[] {
  const entry = model === undefined ? cliDefaultModel(catalog) : (findCatalogModel(catalog, "codex-cli", model)?.model ?? null);
  return entry?.reasoning_efforts ?? CODEX_REASONING_EFFORTS;
}

export interface CatalogIssue {
  /** Path inside ai.yaml, e.g. ["providers", "claude_cli", "model"] or ["tasks", "translate", "models", "claude-cli"]. */
  path: (string | number)[];
  code: "not_in_catalog" | "deprecated" | "effort_unsupported";
  severity: "error" | "warning";
  model: string;
  effort?: string;
  /** English, for config:check. */
  message: string;
}

/** The model choices ai.yaml makes: [path, provider, model]. */
function chosenModels(ai: AiConfig): [(string | number)[], AiProviderIdChoice, string][] {
  const { providers } = ai;
  const out: [(string | number)[], AiProviderIdChoice, string][] = [
    [["providers", "claude_cli", "model"], "claude-cli", providers.claude_cli.model],
    [["providers", "claude_cli", "strong_model"], "claude-cli", providers.claude_cli.strong_model],
    [["providers", "anthropic", "model"], "anthropic", providers.anthropic.model],
    [["providers", "anthropic", "strong_model"], "anthropic", providers.anthropic.strong_model],
    [["providers", "deepseek", "model"], "deepseek", providers.deepseek.model],
    [["providers", "mimo", "model"], "mimo", providers.mimo.model],
  ];
  if (providers.codex_cli.model !== undefined) out.push([["providers", "codex_cli", "model"], "codex-cli", providers.codex_cli.model]);
  for (const task of AI_TASK_NAMES) {
    for (const [provider, model] of Object.entries(ai.tasks[task].models ?? {})) {
      out.push([["tasks", task, "models", provider], provider as AiProviderIdChoice, model]);
    }
  }
  return out;
}

export function checkAiAgainstCatalog(ai: AiConfig, catalog: ModelsConfig): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  for (const [path, provider, model] of chosenModels(ai)) {
    const match = catalog.providers[provider] ? findCatalogModel(catalog, provider, model) : null;
    // an alias only prices a reply; it is not a name to select
    if (!match || match.by !== "id") {
      issues.push({ path, code: "not_in_catalog", severity: "error", model, message: `model "${model}" is not in models.yaml under ${provider}` });
    } else if (match.model.deprecated) {
      issues.push({ path, code: "deprecated", severity: "warning", model, message: `model "${model}" of ${provider} is deprecated in models.yaml` });
    }
  }
  const codex = ai.providers.codex_cli;
  const reported = new Set<string>();
  for (const task of AI_TASK_NAMES) {
    const taskModel = ai.tasks[task].models?.["codex-cli"];
    const model = taskModel ?? codex.model;
    const taskEffort = codex.reasoning_effort_by_task[task];
    const effort = taskEffort ?? codex.reasoning_effort;
    if (supportedEfforts(catalog, model).includes(effort)) continue;
    const path: (string | number)[] = taskEffort !== undefined
      ? ["providers", "codex_cli", "reasoning_effort_by_task", task]
      : taskModel !== undefined
        ? ["tasks", task, "models", "codex-cli"]
        : ["providers", "codex_cli", "reasoning_effort"];
    const key = path.join(".");
    if (reported.has(key)) continue;
    reported.add(key);
    const name = model ?? "the codex CLI default model";
    issues.push({ path, code: "effort_unsupported", severity: "error", model: model ?? "", effort, message: `${name} does not support reasoning effort "${effort}"` });
  }
  return issues;
}

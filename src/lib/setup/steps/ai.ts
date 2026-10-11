/**
 * Setup step 6: AI. Switches providers on / off, sets the global order and the default / strong model of each provider
 * (models.yaml ids). Validated with the ai.yaml schema and checked against the model catalog before the write; only the
 * catalog problems this save introduces block it (an older problem elsewhere in ai.yaml is the settings page's business).
 */
import { AI_PROVIDER_CONFIG_KEYS, AI_PROVIDER_IDS, type AiProviderIdChoice } from "@/lib/config/ai-options";
import { aiSchema, checkAiAgainstCatalog, writeConfig, type AiConfig, type CatalogIssue } from "@/lib/config";

import { aiInputSchema, type AiInput } from "../inputs";
import { stepError, type SetupFieldError, type SetupStepResult } from "../types";
import { editable, finishStep, readFresh, zodSetupErrors } from "./common";

/** Providers that have a strong model next to the default one. */
export const STRONG_MODEL_PROVIDERS: readonly AiProviderIdChoice[] = ["claude-cli", "anthropic"];

const issueKey = (issue: CatalogIssue): string => `${issue.path.join(".")}|${issue.code}|${issue.model}`;

/** The provider a path inside ai.yaml (`providers.claude_cli.model`) belongs to. */
function providerOfPath(path: ReadonlyArray<PropertyKey>): AiProviderIdChoice | null {
  if (path[0] !== "providers") return null;
  return AI_PROVIDER_IDS.find((id) => AI_PROVIDER_CONFIG_KEYS[id] === path[1]) ?? null;
}

/** Wizard field of an ai.yaml path: `providers.claude-cli.model`, `order`. */
function fieldOf(path: ReadonlyArray<PropertyKey>): string {
  const provider = providerOfPath(path);
  if (provider !== null) {
    const key = String(path[2] ?? "");
    return `providers.${provider}.${key === "strong_model" || key === "enabled" ? key : "model"}`;
  }
  return path[0] === "order" ? "order" : String(path[0] ?? "");
}

/** ai.yaml with the step's choices applied (pure). */
export function applyAiInput(current: AiConfig, input: AiInput): AiConfig {
  const next = editable(current);
  if (input.order !== undefined) next.order = [...input.order];
  for (const id of AI_PROVIDER_IDS) {
    const choice = input.providers[id];
    if (choice === undefined) continue;
    const block = next.providers[AI_PROVIDER_CONFIG_KEYS[id]] as { enabled: boolean; model?: string; strong_model?: string };
    block.enabled = choice.enabled;
    const model = choice.model?.trim();
    if (model !== undefined) {
      if (model !== "") block.model = model;
      else if (id === "codex-cli") delete block.model;
    }
    const strong = choice.strong_model?.trim();
    if (strong !== undefined && strong !== "" && STRONG_MODEL_PROVIDERS.includes(id)) block.strong_model = strong;
  }
  return next;
}

export async function saveAiStep(raw: unknown): Promise<SetupStepResult> {
  const parsed = aiInputSchema.safeParse(raw);
  if (!parsed.success) return stepError("ai", "invalidPayload");
  if (parsed.data.order !== undefined && parsed.data.order.length === 0) return stepError("ai", null, [{ path: "order", ns: "setup", key: "orderEmpty" }]);
  const current = readFresh("ai");
  if (current === null) return stepError("ai", "configUnreadable");
  const catalog = readFresh("models");
  if (catalog === null) return stepError("ai", "catalogUnreadable");

  const next = aiSchema.safeParse(applyAiInput(current, parsed.data));
  if (!next.success) return stepError("ai", null, zodSetupErrors(next.error, fieldOf));
  const before = new Set(checkAiAgainstCatalog(current, catalog).map(issueKey));
  const introduced = checkAiAgainstCatalog(next.data, catalog).filter((issue) => issue.severity === "error" && !before.has(issueKey(issue)));
  if (introduced.length > 0) {
    const errors: SetupFieldError[] = introduced.map((issue) => ({ path: fieldOf(issue.path), ns: "setup", key: issue.code === "not_in_catalog" ? "notInCatalog" : "invalid", params: { model: issue.model, message: issue.message } }));
    return stepError("ai", null, errors);
  }
  try {
    await writeConfig("ai", next.data);
  } catch {
    return stepError("ai", "writeFailed");
  }
  return finishStep("ai");
}

/**
 * The fixed choices of `config/ai.yaml`: the single source the zod schema (`schemas/ai.ts`) builds its enums
 * from and the settings page offers in its dropdowns. Plain constants without zod, so the browser bundle can import
 * them. Model names are not fixed here: the catalog of each provider is `config/models.yaml`.
 */

/** `order`: the subscription CLIs and the API layer as a whole. */
export const AI_PROVIDER_KINDS = ["claude-cli", "codex-cli", "api"] as const;
/** `api_order`: the pay-per-token providers. */
export const AI_API_PROVIDERS = ["anthropic", "openai", "openrouter", "deepseek", "mimo"] as const;
/** `tasks.<task>.order`: a task may name individual providers or the "api" layer as a whole. */
export const AI_TASK_PROVIDERS = [...AI_PROVIDER_KINDS, ...AI_API_PROVIDERS] as const;
/** The task kinds that may override the order (`tasks.<task>`) and the codex effort (`reasoning_effort_by_task.<task>`). */
export const AI_TASK_NAMES = ["score", "signals", "translate", "summarize", "suggest", "breakdown", "traps", "salary_lookup", "write"] as const;
/** Codex reasoning effort levels (`-c model_reasoning_effort=`). */
export const CODEX_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export type AiProviderKindChoice = (typeof AI_PROVIDER_KINDS)[number];
export type AiApiProviderChoice = (typeof AI_API_PROVIDERS)[number];
export type AiTaskProviderChoice = (typeof AI_TASK_PROVIDERS)[number];
export type AiTaskName = (typeof AI_TASK_NAMES)[number];

/** Key of each provider's block under `ai.yaml: providers`. */
export const AI_PROVIDER_CONFIG_KEYS = {
  "claude-cli": "claude_cli",
  "codex-cli": "codex_cli",
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openrouter",
  deepseek: "deepseek",
  mimo: "mimo",
} as const satisfies Record<Exclude<AiTaskProviderChoice, "api">, string>;

export type AiProviderConfigKey = (typeof AI_PROVIDER_CONFIG_KEYS)[keyof typeof AI_PROVIDER_CONFIG_KEYS];

/** The concrete providers (hyphen ids, the names of `order`, `ai_usage.provider` and `models.yaml: providers`). */
export const AI_PROVIDER_IDS = ["claude-cli", "codex-cli", "anthropic", "openai", "openrouter", "deepseek", "mimo"] as const;
export type AiProviderIdChoice = (typeof AI_PROVIDER_IDS)[number];

/** `cli` providers run on a subscription (cost 0); `api` providers are pay-per-token and budget-capped. */
export type AiProviderKindName = "cli" | "api";

export const AI_PROVIDER_KIND: Record<AiProviderIdChoice, AiProviderKindName> = {
  "claude-cli": "cli",
  "codex-cli": "cli",
  anthropic: "api",
  openai: "api",
  openrouter: "api",
  deepseek: "api",
  mimo: "api",
};

/** The pay-per-token providers that speak the OpenAI chat-completions API (`providers/openai-compatible.ts`). */
export const AI_OPENAI_COMPATIBLE_PROVIDERS = ["openai", "openrouter", "deepseek", "mimo"] as const;
export type AiOpenAiCompatibleProvider = (typeof AI_OPENAI_COMPATIBLE_PROVIDERS)[number];

/** Name of the request field that caps the reply length (OpenAI's newer models take only `max_completion_tokens`). */
export const AI_MAX_TOKENS_FIELDS = ["max_tokens", "max_completion_tokens"] as const;
export type AiMaxTokensField = (typeof AI_MAX_TOKENS_FIELDS)[number];

/** OpenRouter `provider.data_collection`: `deny` routes only to upstreams that do not store requests to train on them. */
export const OPENROUTER_DATA_COLLECTION = ["deny", "allow"] as const;

export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

/** Values of `ai_usage.outcome` and `ai_usage.model_source`. No server dependencies: browser components import this. */
export const AI_USAGE_OUTCOMES = ["ok", "invalid_output", "failed"] as const;
export type AiUsageOutcome = (typeof AI_USAGE_OUTCOMES)[number];

export const AI_MODEL_SOURCES = ["call", "cli_default", "assumed"] as const;
export type AiModelSource = (typeof AI_MODEL_SOURCES)[number];

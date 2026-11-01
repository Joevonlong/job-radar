import type { ChannelLogger } from "@/lib/channels/types";
import type { AiConfig } from "@/lib/config";
import { AI_OPENAI_COMPATIBLE_PROVIDERS, type AiOpenAiCompatibleProvider } from "@/lib/config/ai-options";

import type { AiProvider } from "../types";
import { createAnthropicProvider } from "./anthropic";
import { createClaudeCliProvider } from "./claude-cli";
import { createCodexCliProvider } from "./codex-cli";
import { createOpenAiCompatibleProvider } from "./openai-compatible";
import type { ProcessRunner } from "./process";

export interface DefaultProviderDeps {
  /** Credentials and PATH come from here (default: process.env). */
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  runProcess?: ProcessRunner;
  /** The CLI providers log the shape (names only) of their output here at debug level. */
  logger?: Pick<ChannelLogger, "debug">;
}

/** The `.env` variable holding each OpenAI-compatible provider's key. */
export const OPENAI_COMPATIBLE_KEY_ENV = {
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mimo: "MIMO_API_KEY",
} as const satisfies Record<AiOpenAiCompatibleProvider, string>;

const nonEmpty = (value: string | undefined): string | undefined => (value !== undefined && value.trim() !== "" ? value.trim() : undefined);

/** The real providers, wired from ai.yaml and the environment. */
export function createDefaultProviders(config: AiConfig, deps: DefaultProviderDeps = {}): AiProvider[] {
  const env = deps.env ?? process.env;
  const timeoutMs = config.api_timeout_seconds * 1000;
  return [
    createClaudeCliProvider({ config: config.providers.claude_cli, env, ...(deps.runProcess ? { runProcess: deps.runProcess } : {}), ...(deps.logger ? { logger: deps.logger } : {}) }),
    createCodexCliProvider({ config: config.providers.codex_cli, env, ...(deps.runProcess ? { runProcess: deps.runProcess } : {}), ...(deps.logger ? { logger: deps.logger } : {}) }),
    createAnthropicProvider({
      config: config.providers.anthropic,
      apiKey: nonEmpty(env.ANTHROPIC_API_KEY),
      timeoutMs,
      maxOutputTokens: config.max_output_tokens,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    }),
    ...AI_OPENAI_COMPATIBLE_PROVIDERS.map((id) => {
      const block = config.providers[id];
      return createOpenAiCompatibleProvider({
        id,
        baseUrl: block.base_url,
        model: block.model,
        apiKey: nonEmpty(env[OPENAI_COMPATIBLE_KEY_ENV[id]]),
        keyName: OPENAI_COMPATIBLE_KEY_ENV[id],
        jsonModeOnly: block.json_mode_only,
        maxTokensField: block.max_tokens_field,
        ...(id === "openrouter" ? { routing: config.providers.openrouter.routing } : {}),
        env,
        timeoutMs,
        maxOutputTokens: config.max_output_tokens,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
    }),
  ];
}

import type { AiConfig } from "@/lib/config";

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
}

const nonEmpty = (value: string | undefined): string | undefined => (value !== undefined && value.trim() !== "" ? value.trim() : undefined);

/** The five real providers, wired from ai.yaml and the environment. */
export function createDefaultProviders(config: AiConfig, deps: DefaultProviderDeps = {}): AiProvider[] {
  const env = deps.env ?? process.env;
  const timeoutMs = config.api_timeout_seconds * 1000;
  return [
    createClaudeCliProvider({ config: config.providers.claude_cli, env, ...(deps.runProcess ? { runProcess: deps.runProcess } : {}) }),
    createCodexCliProvider({ config: config.providers.codex_cli, env, ...(deps.runProcess ? { runProcess: deps.runProcess } : {}) }),
    createAnthropicProvider({
      config: config.providers.anthropic,
      apiKey: nonEmpty(env.ANTHROPIC_API_KEY),
      timeoutMs,
      maxOutputTokens: config.max_output_tokens,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    }),
    createOpenAiCompatibleProvider({
      id: "deepseek",
      baseUrl: config.providers.deepseek.base_url,
      model: config.providers.deepseek.model,
      apiKey: nonEmpty(env.DEEPSEEK_API_KEY),
      keyName: "DEEPSEEK_API_KEY",
      jsonModeOnly: config.providers.deepseek.json_mode_only,
      env,
      timeoutMs,
      maxOutputTokens: config.max_output_tokens,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    }),
    createOpenAiCompatibleProvider({
      id: "mimo",
      baseUrl: config.providers.mimo.base_url,
      model: config.providers.mimo.model,
      apiKey: nonEmpty(env.MIMO_API_KEY),
      keyName: "MIMO_API_KEY",
      jsonModeOnly: config.providers.mimo.json_mode_only,
      env,
      timeoutMs,
      maxOutputTokens: config.max_output_tokens,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    }),
  ];
}

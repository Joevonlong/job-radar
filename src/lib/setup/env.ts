/**
 * Which environment variables are set, by name. The values are only ever compared with the empty string here and
 * never leave this module (C4): every result is `{ name, present }`.
 */
import { CHANNEL_REQUIRED_ENV } from "@/lib/sources/required-env";
import type { AiProviderIdChoice } from "@/lib/config/ai-options";

import type { EnvPresence } from "./types";

export type EnvSource = Readonly<Record<string, string | undefined>>;

/** The key variable of each pay-per-token provider (the subscription CLIs log in on the host instead). */
export const AI_KEY_ENV: Readonly<Partial<Record<AiProviderIdChoice, string>>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mimo: "MIMO_API_KEY",
};

export const TELEGRAM_ENV = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] as const;

export function isSet(env: EnvSource, name: string): boolean {
  return (env[name] ?? "").trim() !== "";
}

/** Each name with whether it is set. */
export function envPresence(names: readonly string[], env: EnvSource = process.env): EnvPresence[] {
  return names.map((name) => ({ name, present: isSet(env, name) }));
}

/** The variables a channel needs (names, present / absent); empty when it needs none. */
export function channelEnv(id: string, env: EnvSource = process.env): EnvPresence[] {
  return envPresence(CHANNEL_REQUIRED_ENV[id] ?? [], env);
}

/** The key of an API provider (name, present / absent); null for the subscription CLIs. */
export function aiKeyEnv(provider: AiProviderIdChoice, env: EnvSource = process.env): EnvPresence | null {
  const name = AI_KEY_ENV[provider];
  return name === undefined ? null : { name, present: isSet(env, name) };
}

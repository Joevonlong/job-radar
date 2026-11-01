/**
 * How the settings page groups the AI providers: by vendor, each vendor reachable in one or two ways.
 * This is a code fact about the providers, not a config value: `ai.yaml` keeps its provider ids and layout; the grouping is display only.
 */
import type { AiProviderConfigKey, AiProviderIdChoice } from "../config/ai-options";
import { AI_PROVIDER_CONFIG_KEYS, AI_PROVIDER_KIND, type AiProviderKindName } from "../config/ai-options";

export const AI_VENDOR_IDS = ["anthropic", "openai", "openrouter", "deepseek", "mimo"] as const;
export type AiVendorId = (typeof AI_VENDOR_IDS)[number];

export interface AiVendor {
  id: AiVendorId;
  /** The providers (access modes) of the vendor, subscription CLI before API. */
  providers: readonly AiProviderIdChoice[];
}

export const AI_VENDORS: readonly AiVendor[] = [
  { id: "anthropic", providers: ["claude-cli", "anthropic"] },
  { id: "openai", providers: ["codex-cli", "openai"] },
  { id: "openrouter", providers: ["openrouter"] },
  { id: "deepseek", providers: ["deepseek"] },
  { id: "mimo", providers: ["mimo"] },
];

/** The vendor a provider belongs to. */
export function vendorOf(provider: AiProviderIdChoice): AiVendorId {
  const vendor = AI_VENDORS.find((v) => v.providers.includes(provider));
  // every provider id is listed above (tests/settings/ai-vendors.test.ts)
  return vendor?.id ?? "anthropic";
}

/** `cli` = subscription CLI, `api` = pay per token. */
export const accessOf = (provider: AiProviderIdChoice): AiProviderKindName => AI_PROVIDER_KIND[provider];

/** Key of the provider's block in `ai.yaml: providers`. */
export const configKeyOf = (provider: AiProviderIdChoice): AiProviderConfigKey => AI_PROVIDER_CONFIG_KEYS[provider];

/** Draft path of one of the provider's keys (`providers.claude_cli.model`). */
export const providerPath = (provider: AiProviderIdChoice, key: string): string => `providers.${configKeyOf(provider)}.${key}`;

/** Order / task nodes that are a provider id (everything but the `api` layer). */
export function isProviderNode(value: string): value is AiProviderIdChoice {
  return Object.hasOwn(AI_PROVIDER_CONFIG_KEYS, value);
}

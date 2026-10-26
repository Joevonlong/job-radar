import { isConfiguredChannelId, settingsFromConfig } from "@/lib/channels/registry";
import type { ChannelsConfig } from "@/lib/config";
import { GMAIL_APP_PASSWORD_ENV, GMAIL_USER_ENV } from "@/lib/channels/email/channel";
import { BRAVE_API_KEY_ENV } from "@/lib/channels/discovery/brave";
import { TAVILY_API_KEY_ENV } from "@/lib/channels/discovery/tavily";
import { JSEARCH_API_KEY_ENV } from "@/lib/channels/jsearch";
import { APIFY_TOKEN_ENV } from "@/lib/channels/linkedin/apify/contract";
import { MONID_API_KEY_ENV } from "@/lib/channels/linkedin/monid/contract";
import { BRIGHTDATA_API_KEY_ENV } from "@/lib/channels/linkedin/brightdata/contract";

/** Environment variables a channel needs before it can do anything (names only; values are never read into a report). */
export const CHANNEL_REQUIRED_ENV: Readonly<Record<string, readonly string[]>> = {
  "linkedin-brightdata": [BRIGHTDATA_API_KEY_ENV],
  "linkedin-apify": [APIFY_TOKEN_ENV],
  "linkedin-monid": [MONID_API_KEY_ENV],
  brave: [BRAVE_API_KEY_ENV],
  tavily: [TAVILY_API_KEY_ENV],
  jsearch: [JSEARCH_API_KEY_ENV],
  "gmail-alerts": [GMAIL_USER_ENV, GMAIL_APP_PASSWORD_ENV],
};

/** The variables of channel `id` that are not set in `env`; empty = nothing missing (or the channel needs none). Names only, never values. */
export function missingChannelEnv(env: Readonly<Record<string, string | undefined>>, id: string): string[] {
  return (CHANNEL_REQUIRED_ENV[id] ?? []).filter((name) => (env[name] ?? "").trim() === "");
}

/** For each of `ids` that is enabled in sources.yaml and lacks a required variable: the missing names (names only). Channels with nothing missing are left out. */
export function missingEnvOfEnabled(config: ChannelsConfig, env: Readonly<Record<string, string | undefined>>, ids: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const id of ids) {
    if (!isConfiguredChannelId(id) || !settingsFromConfig(id, config).enabled) continue;
    const missing = missingChannelEnv(env, id);
    if (missing.length > 0) out[id] = missing;
  }
  return out;
}

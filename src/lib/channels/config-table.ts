import type { ChannelsConfig } from "@/lib/config";

type LinkedinKey = "brightdata" | "apify" | "monid" | "session" | "guest";
type SourceKey = keyof ChannelsConfig["sources"];

/** Which view of its config block a channel uses; `recommended` = the "recommended for you" side channel of `linkedin.session`. */
type ConfigView = "recommended";

export type ChannelConfigRef = (
  | { readonly section: "linkedin"; readonly key: LinkedinKey; readonly view?: ConfigView }
  | { readonly section: "sources"; readonly key: SourceKey }
) & { readonly usesQueries?: false; readonly supportsCompanyQueries?: true };

/**
 * The single table linking a channel id to its block in sources.yaml. A channel can only be
 * registered (and therefore enabled) if it has an entry here. Source channels use the config key as id.
 */
export const CHANNEL_CONFIG_TABLE = {
  "linkedin-brightdata": { section: "linkedin", key: "brightdata" },
  "linkedin-apify": { section: "linkedin", key: "apify" },
  "linkedin-monid": { section: "linkedin", key: "monid" },
  "linkedin-session": { section: "linkedin", key: "session", supportsCompanyQueries: true },
  "linkedin-session:recommended": { section: "linkedin", key: "session", view: "recommended", usesQueries: false },
  "linkedin-guest": { section: "linkedin", key: "guest", supportsCompanyQueries: true },
  arbeitsagentur: { section: "sources", key: "arbeitsagentur", supportsCompanyQueries: true },
  indeed: { section: "sources", key: "indeed", supportsCompanyQueries: true },
  stepstone: { section: "sources", key: "stepstone" },
  xing: { section: "sources", key: "xing" },
  arbeitnow: { section: "sources", key: "arbeitnow", usesQueries: false },
  jsearch: { section: "sources", key: "jsearch" },
  greenhouse: { section: "sources", key: "greenhouse", usesQueries: false },
  lever: { section: "sources", key: "lever", usesQueries: false },
  ashby: { section: "sources", key: "ashby", usesQueries: false },
  personio: { section: "sources", key: "personio", usesQueries: false },
  smartrecruiters: { section: "sources", key: "smartrecruiters", usesQueries: false },
  brave: { section: "sources", key: "brave", usesQueries: false },
  tavily: { section: "sources", key: "tavily", usesQueries: false },
  "gmail-alerts": { section: "sources", key: "gmail", usesQueries: false },
  "jobspy-google": { section: "sources", key: "jobspy_google", supportsCompanyQueries: true },
} as const satisfies Record<string, ChannelConfigRef>;

export type ConfiguredChannelId = keyof typeof CHANNEL_CONFIG_TABLE;

/** Static keyword capability for the web process, which has no channel instances. */
export function channelUsesQueries(id: string): boolean {
  if (!isConfiguredChannelId(id)) return false;
  const ref: ChannelConfigRef = CHANNEL_CONFIG_TABLE[id];
  return ref.usesQueries !== false;
}

/** Company capability for the web process, which has no collector instances. */
export function channelSupportsCompanyQueries(id: string): boolean {
  if (!isConfiguredChannelId(id)) return false;
  const ref: ChannelConfigRef = CHANNEL_CONFIG_TABLE[id];
  return ref.supportsCompanyQueries === true;
}

export function isConfiguredChannelId(id: string): id is ConfiguredChannelId {
  return Object.hasOwn(CHANNEL_CONFIG_TABLE, id);
}


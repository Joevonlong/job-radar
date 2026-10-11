/** Source registry entries: every collection source of config/sources.yaml as one flat list. Pure. */
import { CHANNEL_CONFIG_TABLE, settingsFromConfig, type ConfiguredChannelId } from "@/lib/channels/registry";
import type { ChannelsConfig } from "@/lib/config";
import { ATS_KINDS } from "@/lib/config/schemas/companies";
import type { SourceRegistryRowInput } from "@/lib/db/repos/source-registry";

export const REGISTRY_ENTRY_TYPES = ["channel", "ats_board"] as const;
export type RegistryEntryType = (typeof REGISTRY_ENTRY_TYPES)[number];

import type { RegistryGroup } from "./groups";

export { REGISTRY_GROUPS, type RegistryGroup } from "./groups";

export type AtsKind = (typeof ATS_KINDS)[number];

/** Channels per group in display order (the LinkedIn group follows `linkedin.cascade` instead). Code classification, not a tunable value. */
const GROUP_MEMBERS: Record<Exclude<RegistryGroup, "linkedin">, readonly ConfiguredChannelId[]> = {
  job_boards: ["arbeitsagentur", "indeed", "stepstone", "xing", "arbeitnow"],
  search_apis: ["jsearch", "jobspy-google"],
  email: ["gmail-alerts"],
  ats: ["greenhouse", "lever", "ashby", "personio", "smartrecruiters"],
  discovery: ["tavily", "brave"],
};

/** Channel id -> group. Every id of `CHANNEL_CONFIG_TABLE` must be here (a unit test keeps it so). */
export const CHANNEL_GROUP: Record<ConfiguredChannelId, RegistryGroup> = {
  "linkedin-brightdata": "linkedin",
  "linkedin-apify": "linkedin",
  "linkedin-session": "linkedin",
  "linkedin-session:recommended": "linkedin",
  "linkedin-guest": "linkedin",
  arbeitsagentur: "job_boards",
  indeed: "job_boards",
  stepstone: "job_boards",
  xing: "job_boards",
  arbeitnow: "job_boards",
  jsearch: "search_apis",
  "jobspy-google": "search_apis",
  "gmail-alerts": "email",
  greenhouse: "ats",
  lever: "ats",
  ashby: "ats",
  personio: "ats",
  smartrecruiters: "ats",
  tavily: "discovery",
  brave: "discovery",
};

export interface RegistryEntry {
  /** `greenhouse` | `board:greenhouse:celonis`. */
  id: string;
  type: RegistryEntryType;
  group: RegistryGroup;
  /** A channel: its id; a board: `ats_boards[].name`. */
  name: string;
  /** A board's ATS channel id. */
  parentId: string | null;
  enabled: boolean;
  /** The path the enabled switch writes, e.g. `["linkedin","session","recommended_daily"]`, `["ats_boards", 12, "enabled"]`. */
  enabledPath: readonly (string | number)[];
  /** A channel: its config block; a board: `{ ats, token, region? }`. */
  params: Record<string, unknown>;
}

export function boardEntryId(ats: string, token: string): string {
  return `board:${ats}:${token}`;
}

export function parseBoardEntryId(id: string): { ats: AtsKind; token: string } | null {
  const match = /^board:([a-z]+):(.+)$/.exec(id);
  const ats = match?.[1];
  const token = match?.[2];
  if (!ats || !token) return null;
  const kind = ATS_KINDS.find((k) => k === ats);
  return kind ? { ats: kind, token } : null;
}

function channelEnabledPath(id: ConfiguredChannelId): readonly string[] {
  const ref = CHANNEL_CONFIG_TABLE[id];
  if (ref.section === "linkedin") return "view" in ref ? ["linkedin", "session", "recommended_daily"] : ["linkedin", ref.key, "enabled"];
  return ["sources", ref.key, "enabled"];
}

function channelParams(id: ConfiguredChannelId, config: ChannelsConfig): Record<string, unknown> {
  const ref = CHANNEL_CONFIG_TABLE[id];
  const block = ref.section === "linkedin" ? config.linkedin[ref.key] : config.sources[ref.key];
  return JSON.parse(JSON.stringify(block)) as Record<string, unknown>;
}

/** Channel ids in registry order: LinkedIn by cascade (then the "recommended" side channel), the other groups as listed above. */
export function orderedChannelIds(config: ChannelsConfig): ConfiguredChannelId[] {
  const linkedin: ConfiguredChannelId[] = [...config.linkedin.cascade, "linkedin-session:recommended"];
  const rest = (Object.keys(CHANNEL_CONFIG_TABLE) as ConfiguredChannelId[]).filter((id) => CHANNEL_GROUP[id] === "linkedin" && !linkedin.includes(id));
  return [...linkedin, ...rest, ...Object.values(GROUP_MEMBERS).flat()];
}

/** All entries: channels (grouped, cascade order) first, then the ATS boards in file order. */
export function buildRegistryEntries(config: ChannelsConfig): RegistryEntry[] {
  const channels = orderedChannelIds(config).map(
    (id): RegistryEntry => ({
      id,
      type: "channel",
      group: CHANNEL_GROUP[id],
      name: id,
      parentId: null,
      enabled: settingsFromConfig(id, config).enabled,
      enabledPath: channelEnabledPath(id),
      params: channelParams(id, config),
    }),
  );
  const boards = config.ats_boards.map(
    (board, index): RegistryEntry => ({
      id: boardEntryId(board.ats, board.token),
      type: "ats_board",
      group: "ats",
      name: board.name,
      parentId: board.ats,
      enabled: board.enabled,
      enabledPath: ["ats_boards", index, "enabled"],
      params: { ats: board.ats, token: board.token, ...(board.region ? { region: board.region } : {}) },
    }),
  );
  return [...channels, ...boards];
}

/** The rows the database mirror stores for `config`. */
export function registryRowsFromConfig(config: ChannelsConfig): SourceRegistryRowInput[] {
  return buildRegistryEntries(config).map((e) => ({ id: e.id, type: e.type, group: e.group, name: e.name, parentId: e.parentId, enabled: e.enabled, params: e.params }));
}

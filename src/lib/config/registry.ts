import type { z } from "zod";

import { activityLogSchema } from "./schemas/activity-log";
import { aiSchema } from "./schemas/ai";
import { breakdownSchema } from "./schemas/breakdown";
import { channelsSchema } from "./schemas/channels";
import { insightsSchema } from "./schemas/insights";
import { interestsSchema } from "./schemas/interests";
import { languageSchema } from "./schemas/language";
import { mcpSchema } from "./schemas/mcp";
import { meSchema } from "./schemas/me";
import { modelsSchema } from "./schemas/models";
import { notifySchema } from "./schemas/notify";
import { pipelineSchema } from "./schemas/pipeline";
import { pipelineBoardSchema } from "./schemas/pipeline-board";
import { preferencesSchema } from "./schemas/preferences";
import { resumeSchema } from "./schemas/resume";
import { salarySchema } from "./schemas/salary";
import { signalPresetsSchema } from "./schemas/signal-presets";
import { scheduleSchema } from "./schemas/schedule";
import { searchSchema } from "./schemas/search";
import { setupSchema } from "./schemas/setup";
import { trapsSchema } from "./schemas/traps";
import { uiSchema } from "./schemas/ui";

/**
 * Every config file. `location`: `config` = the layered config directories, `profile` = the profile directory.
 * `kind` decides how the layers treat a `config` file:
 * - `user`: copied from the defaults directory into the user directory on first start (`pnpm config:init`), then owned
 *   by the user; product upgrades never change it (a migration may, see `migrations/`).
 * - `shipped`: not copied; read from the defaults directory and upgraded with the product. A same-named file in the
 *   user directory replaces it as a whole (the doctor warns: product updates of that file no longer apply).
 * Profile files are `user` too; their templates live in `<defaults>/profile.example`.
 */
export const configRegistry = {
  schedule: { file: "schedule.yaml", location: "config", kind: "user", schema: scheduleSchema },
  search: { file: "search.yaml", location: "config", kind: "user", schema: searchSchema },
  channels: { file: "sources.yaml", location: "config", kind: "user", schema: channelsSchema },
  ai: { file: "ai.yaml", location: "config", kind: "user", schema: aiSchema },
  breakdown: { file: "breakdown.yaml", location: "config", kind: "user", schema: breakdownSchema },
  models: { file: "models.yaml", location: "config", kind: "shipped", schema: modelsSchema },
  notify: { file: "notify.yaml", location: "config", kind: "user", schema: notifySchema },
  interests: { file: "interests.yaml", location: "config", kind: "user", schema: interestsSchema },
  pipeline: { file: "pipeline.yaml", location: "config", kind: "shipped", schema: pipelineSchema },
  pipelineBoard: { file: "pipeline-board.yaml", location: "config", kind: "shipped", schema: pipelineBoardSchema },
  resume: { file: "resume.yaml", location: "config", kind: "user", schema: resumeSchema },
  insights: { file: "insights.yaml", location: "config", kind: "user", schema: insightsSchema },
  ui: { file: "ui.yaml", location: "config", kind: "user", schema: uiSchema },
  /** interface, AI output, translation, Telegram and command-line languages. */
  language: { file: "language.yaml", location: "config", kind: "user", schema: languageSchema },
  /** The state of the first-run setup (wizard / `pnpm run setup`); an existing install gets it marked complete on its first start. */
  setup: { file: "setup.yaml", location: "config", kind: "user", schema: setupSchema },
  /** Shipped rule data (patterns, thresholds); a user who wants other rules overrides the whole file. */
  traps: { file: "traps.yaml", location: "config", kind: "shipped", schema: trapsSchema },
  /** Salary benchmark (role families, window), deep links and the on-demand AI salary lookup. */
  salary: { file: "salary.yaml", location: "config", kind: "user", schema: salarySchema },
  /** Starting points of the "add a category" dialog on /interests (shipped: a user copy replaces it as a whole). */
  signalPresets: { file: "signal-presets.yaml", location: "config", kind: "shipped", schema: signalPresetsSchema },
  /** The optional read-only MCP server (`pnpm mcp:serve`); off by default, every key has a default. */
  mcp: { file: "mcp.yaml", location: "config", kind: "user", schema: mcpSchema },
  /** The operations log of the runner and ai-worker: retention, writer limits, page settings (shipped). */
  activityLog: { file: "activity-log.yaml", location: "config", kind: "shipped", schema: activityLogSchema },
  me: { file: "me.yaml", location: "profile", kind: "user", schema: meSchema },
  preferences: { file: "preferences.yaml", location: "profile", kind: "user", schema: preferencesSchema },
} as const;

export type ConfigName = keyof typeof configRegistry;
export type ConfigValue<N extends ConfigName> = z.infer<(typeof configRegistry)[N]["schema"]>;

export const CONFIG_NAMES = Object.keys(configRegistry) as ConfigName[];
export const PROFILE_NAMES = ["me", "preferences"] as const satisfies readonly ConfigName[];
export type ProfileName = (typeof PROFILE_NAMES)[number];

export function isProfileName(name: ConfigName): name is ProfileName {
  return configRegistry[name].location === "profile";
}

/** Config files in the layered config directories (everything except the profile files). */
export const LAYERED_CONFIG_NAMES = CONFIG_NAMES.filter((name) => configRegistry[name].location === "config");
/** `user` files are copied into the user directory by `pnpm config:init`; `shipped` ones stay in the defaults directory. */
export const USER_CONFIG_NAMES = LAYERED_CONFIG_NAMES.filter((name) => configRegistry[name].kind === "user");
export const SHIPPED_CONFIG_NAMES = LAYERED_CONFIG_NAMES.filter((name) => configRegistry[name].kind === "shipped");

/**
 * The editable config files that have a form on /settings (one form per file, saved on its own), in display order.
 * Insights and resume were added later; a page tab can hold several forms (`TAB_LAYOUT`).
 */
export const SETTINGS_FORMS = ["schedule", "search", "channels", "ai", "breakdown", "salary", "notify", "language", "ui", "insights", "resume"] as const;
export type SettingsForm = (typeof SETTINGS_FORMS)[number];

export function isSettingsForm(value: string): value is SettingsForm {
  return (SETTINGS_FORMS as readonly string[]).includes(value);
}

/** File name of each form's config (mirrors `configRegistry`; tests compare them). */
export const SETTINGS_FILES: Record<SettingsForm, string> = {
  schedule: "schedule.yaml",
  search: "search.yaml",
  channels: "sources.yaml",
  ai: "ai.yaml",
  breakdown: "breakdown.yaml",
  salary: "salary.yaml",
  notify: "notify.yaml",
  language: "language.yaml",
  ui: "ui.yaml",
  insights: "insights.yaml",
  resume: "resume.yaml",
};

/** The tabs that edit config: form tabs and the application workflow tab (a status table plus the resume form). */
export const CONFIG_PAGE_TABS = ["schedule", "search", "channels", "ai", "breakdown", "salary", "notify", "ui", "workflow"] as const;
export type ConfigPageTab = (typeof CONFIG_PAGE_TABS)[number];

/** The manual operations tab. It edits no file. */
export const ACTIONS_TAB = "actions" as const;
/** The raw YAML editor of every config file (`?tab=advanced&file=<name>`). */
export const ADVANCED_TAB = "advanced" as const;
/** Every tab of the page, in display order: the config tabs, then (after a divider) the operations tab and the advanced editor. */
export const PAGE_TABS = [...CONFIG_PAGE_TABS, ACTIONS_TAB, ADVANCED_TAB] as const;
export type PageTab = (typeof PAGE_TABS)[number];

/** Which forms a config tab shows, top to bottom. `workflow` also has the status table above its forms. */
export const TAB_LAYOUT: Record<ConfigPageTab, readonly SettingsForm[]> = {
  schedule: ["schedule"],
  search: ["search"],
  channels: ["channels"],
  ai: ["ai"],
  breakdown: ["breakdown"],
  salary: ["salary"],
  notify: ["notify"],
  // The languages head the interface tab
  ui: ["language", "ui", "insights"],
  workflow: ["resume"],
};

/** The tab a form is shown in (where the "fix it in the advanced editor" link of a form that cannot load comes from). */
export function tabOfForm(form: SettingsForm): ConfigPageTab {
  return CONFIG_PAGE_TABS.find((tab) => TAB_LAYOUT[tab].includes(form)) ?? "schedule";
}

/**
 * The configs the runner watches and acknowledges after loading them (widened to everything the runner
 * reads). `ui` is read by the web app too and is listed here so the runner's Telegram buttons see changes.
 */
export const ACK_NAMES = ["schedule", "search", "channels", "ai", "breakdown", "salary", "notify", "ui", "interests", "pipeline", "models", "language"] as const;
export type AckName = (typeof ACK_NAMES)[number];

export function isAckName(value: string): value is AckName {
  return (ACK_NAMES as readonly string[]).includes(value);
}

/** Configs only the web app reads: saving them takes effect on the next page load, so there is nothing for the runner to acknowledge. */
export const WEB_ONLY_CONFIGS = ["ui", "insights", "resume"] as const;
